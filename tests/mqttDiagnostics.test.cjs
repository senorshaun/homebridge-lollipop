'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { observeMqtt, describeMqttFailure } = require('../lib/mqttDiagnostics');
const { createEnvironment } = require('./helpers.cjs');

function observedClient() {
    const client = new EventEmitter();
    client.stream = new EventEmitter();
    const failures = [];
    const diagnostics = observeMqtt(client, (error, stage) => failures.push({ error, stage }));
    return { client, failures, diagnostics };
}

function attachStream(client) {
    client.stream = new EventEmitter();
    client.emit('packetsend', { cmd: 'connect' });
    return client.stream;
}

function loggedErrors(env) {
    return env.state.logs.filter(entry => entry.level === 'error').map(entry => entry.args.join(' '));
}

test('raw TLS errors suppressed by MQTT 4 reach diagnostics once even when the client also forwards them', () => {
    const { client, failures } = observedClient();
    const error = Object.assign(new Error('TLS handshake failure'), { code: 'EPROTO' });
    client.stream.emit('error', error);
    client.emit('error', error);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'TLS handshake');
    assert.equal(failures[0].error, error);
});

test('CONNECT packetsend observes replacement streams despite the earlier reconnect event', () => {
    const { client, failures, diagnostics } = observedClient();
    const oldStream = client.stream;
    oldStream.emit('secureConnect');
    client.emit('connect');
    client.emit('reconnect');
    const newStream = attachStream(client);
    client.emit('packetsend', { cmd: 'connect' });
    assert.equal(newStream.listenerCount('error'), 1);
    oldStream.emit('secureConnect');
    oldStream.emit('error', Object.assign(new Error('Late old stream error'), { code: 'EPROTO' }));
    assert.equal(diagnostics.getStage(), 'TLS handshake');
    assert.equal(failures.length, 0);
    newStream.emit('error', Object.assign(new Error('TLS handshake failure'), { code: 'EPROTO' }));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'TLS handshake');
});

test('TLS secureConnect does not claim MQTT acceptance and a later TLS 1.3 certificate rejection remains visible', () => {
    const { client, failures, diagnostics } = observedClient();
    client.stream.emit('secureConnect');
    assert.equal(diagnostics.getStage(), 'waiting for MQTT CONNECT acceptance');
    client.stream.emit('error', Object.assign(new Error('certificate required'), {
        code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'
    }));
    assert.equal(failures.length, 1);
    const description = describeMqttFailure(failures[0].error, failures[0].stage);
    assert.match(description, /waiting for MQTT CONNECT acceptance/);
    assert.match(description, /server requires a client certificate/);
    client.emit('connect');
    assert.equal(diagnostics.getStage(), 'MQTT session');
});

test('stopped diagnostics absorb late errors without reporting or observing new streams', () => {
    const { client, failures, diagnostics } = observedClient();
    const stream = client.stream;
    diagnostics.stop();
    assert.doesNotThrow(() => stream.emit('error', new Error('late TLS error')));
    assert.doesNotThrow(() => client.emit('error', new Error('late MQTT error')));
    assert.equal(client.listenerCount('packetsend'), 0);
    assert.equal(failures.length, 0);
});

test('diagnostic messages distinguish protocol failures and MQTT refusal without exposing raw messages', () => {
    const secret = 'mqtts://private-user:private-password@192.0.2.10/private-key';
    const protocol = describeMqttFailure({ code: 'EPROTO', message: 'alert protocol version ' + secret }, 'TLS handshake');
    assert.match(protocol, /EPROTO: TLS protocol negotiation failed/);
    const authentication = describeMqttFailure({ code: 4, message: secret }, 'waiting for MQTT CONNECT acceptance');
    assert.match(authentication, /MQTT_CONNACK_4: MQTT username or password rejected/);
    const unknown = describeMqttFailure({ code: secret, message: secret }, 'TLS handshake');
    assert.match(unknown, /UNKNOWN/);
    assert.ok(![protocol, authentication, unknown].join(' ').includes('private-'));
});

test('discovery closes immediately on a raw TLS failure, clears its timer, and ignores late events', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    const stream = attachStream(client);
    const error = Object.assign(new Error('TLS handshake failure private-key-content'), { code: 'EPROTO' });
    stream.emit('error', error);
    client.emit('error', error);
    client.emit('close');
    client.emit('connect');
    client.emit('message', 'late-pairing-id/liveNote', Buffer.from('{}'));
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.equal(env.state.controllers.length, 0);
    assert.equal(client.subscriptions.length, 0);
    assert.equal(loggedErrors(env).length, 1);
    assert.match(loggedErrors(env)[0], /during TLS handshake \[EPROTO: TLS handshake rejected\]/);
    assert.ok(!loggedErrors(env)[0].includes('private-key-content'));
});

test('MQTT CONNECT refusal is reported separately from the preceding TLS connection', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    attachStream(client).emit('secureConnect');
    client.emit('error', Object.assign(new Error('private broker response'), { code: 5 }));
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.match(loggedErrors(env)[0], /waiting for MQTT CONNECT acceptance/);
    assert.match(loggedErrors(env)[0], /MQTT_CONNACK_5: MQTT connection not authorized/);
});

test('a denied wildcard SUBACK ends discovery without waiting for the timeout or accepting later IDs', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    client.subscribe = (topic, callback) => {
        assert.equal(topic, '#');
        callback(null, [{ topic: '#', qos: 128 }]);
    };
    client.emit('connect');
    client.emit('message', 'late-pairing-id/liveNote', Buffer.from('{}'));
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.equal(env.state.controllers.length, 0);
    assert.equal(loggedErrors(env).length, 1);
    assert.match(loggedErrors(env)[0], /during topic subscription/);
    assert.match(loggedErrors(env)[0], /MQTT_SUBSCRIPTION_DENIED/);
});

test('a subscription callback error also terminates discovery with the subscription stage', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    client.subscribe = (topic, callback) => callback(Object.assign(new Error('private subscription details'), { code: 'EACCES' }));
    client.emit('connect');
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.match(loggedErrors(env)[0], /during topic subscription \[EACCES:/);
    assert.ok(!loggedErrors(env)[0].includes('private subscription details'));
});

test('successful discovery still uses the MQTT topic ID and leaves no discovery timer', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    client.subscribe = (topic, callback) => callback(null, [{ topic: '#', qos: 0 }]);
    client.emit('connect');
    client.emit('message', 'synthetic-pairing-id/liveNote', Buffer.from('{}'));
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.equal(env.state.controllers.length, 1);
    assert.equal(env.state.mqtt.length, 2);
    assert.equal(loggedErrors(env).length, 0);
});

test('the existing 15 second bound identifies when MQTT connected but no ID arrived', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    client.emit('connect');
    const timeout = [...env.state.timers].find(([, timer]) => timer.delay === 15000);
    assert.ok(timeout);
    env.runTimer(timeout[0]);
    assert.equal(client.endCalls, 1);
    assert.match(loggedErrors(env)[0], /during waiting for camera ID/);
    assert.match(loggedErrors(env)[0], /MQTT_DISCOVERY_TIMEOUT/);
});

test('a discovery connection that closes without an error fails promptly', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10' });
    const client = env.state.mqtt[0];
    client.emit('close');
    assert.equal(client.endCalls, 1);
    assert.equal(env.state.timers.size, 0);
    assert.match(loggedErrors(env)[0], /MQTT_CONNECTION_CLOSED/);
});

test('status clients report raw failures after reconnect and remain quiet after shutdown', () => {
    const env = createEnvironment();
    env.createCamera({ ip: '192.0.2.10', pairingID: 'synthetic-pairing-id' });
    const client = env.state.mqtt[0];
    const firstStream = attachStream(client);
    firstStream.emit('error', Object.assign(new Error('TLS handshake failure'), { code: 'EPROTO' }));
    assert.equal(loggedErrors(env).length, 1);
    const secondStream = attachStream(client);
    secondStream.emit('secureConnect');
    client.emit('connect');
    secondStream.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    assert.equal(loggedErrors(env).length, 2);
    assert.match(loggedErrors(env)[1], /MQTT session \[ECONNRESET: connection reset\]/);
    env.api.emit('shutdown');
    secondStream.emit('error', new Error('late TLS error'));
    client.emit('error', new Error('late MQTT error'));
    assert.equal(loggedErrors(env).length, 2);
    assert.equal(client.endCalls, 1);
});
