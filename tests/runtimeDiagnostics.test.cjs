'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createEnvironment } = require('./helpers.cjs');

const PRIVATE = {
    email: 'runtime-private-owner@example.invalid',
    password: 'runtime-private-login-password',
    token: 'r:runtime-private-session-token',
    cameraId: 'runtime-private-camera',
    address: '192.0.2.90',
    cert: 'runtime-private-client-certificate',
    key: 'runtime-private-client-key',
    mqttPassword: 'runtime-private-mqtt-password',
    payload: 'runtime-private-message-value',
    otherCamera: 'runtime-private-other-camera',
    signedUrl: 'https://credentials.example.invalid/key?signature=runtime-private-signature'
};

function environment(debug = true) {
    const account = {
        calls: [], emitted: [], lastCameraSource: 'cloud',
        records: [{ cameraId: PRIVATE.cameraId, name: 'Synthetic nursery', ip: PRIVATE.address }],
        credentials: { cert: Buffer.from(PRIVATE.cert), key: Buffer.from(PRIVATE.key) },
        cameraReference: () => 'camera-1',
        report(event, fields) {
            this.emitted.push(event);
            this.options.diagnostics(event, fields);
        },
        async authenticate() {
            this.calls.push('authenticate');
            this.options.registerSecrets([PRIVATE.email, PRIVATE.password, PRIVATE.token]);
            this.report('account.session', { phase: 'complete', outcome: 'success', source: 'cloud' });
            return { authenticated: true };
        },
        async listCameras() {
            this.calls.push('cameras');
            this.options.registerSecrets([PRIVATE.cameraId, PRIVATE.address]);
            this.report('account.cameras', { phase: 'complete', outcome: 'success', source: 'cloud', count: 1 });
            return this.records;
        },
        async getMqttCredentials() {
            this.calls.push('credentials');
            this.options.registerSecrets([PRIVATE.cert, PRIVATE.key, PRIVATE.signedUrl]);
            this.report('account.identity', { phase: 'complete', outcome: 'success', source: 'cache', cached: true, cameraRef: 'camera-1' });
            return this.credentials;
        },
        close() { this.closed = true; }
    };
    class Account {
        constructor(options) {
            account.options = options;
            return account;
        }
    }
    const env = createEnvironment({
        Account, realSoundMachine: true,
        mqttAuth: { createAuthenticatedMqttOptions: ({ cert, key }) => ({
            username: 'lollipop', password: PRIVATE.mqttPassword,
            cert, key, ca: 'synthetic-ca', rejectUnauthorized: true
        }) }
    });
    const config = {
        debug,
        account: { email: PRIVATE.email },
        cameraDefaults: { debug: false, enableSoundMachine: true }
    };
    return { ...env, account, config };
}

const textLogs = env => env.state.logs.flatMap(record => record.args).map(String);
const diagnostics = env => textLogs(env).filter(line => line.includes('[diagnostic #'));
const matching = (env, event, fields = []) => diagnostics(env).filter(line =>
    line.includes('] ' + event + ' ') && fields.every(field => line.includes(field)));

function assertPrivateLogs(env) {
    const logs = textLogs(env).join('\n');
    for (const secret of Object.values(PRIVATE)) assert.ok(!logs.includes(secret), 'A private synthetic value appeared in runtime logs');
    assert.doesNotMatch(diagnostics(env).join('\n'), /diagnostic\.unknown|=UNKNOWN(?:\s|$)/,
        'Expected runtime fields must survive the shared diagnostic vocabulary');
}

function attachTls(client) {
    const stream = new EventEmitter();
    stream.authorized = true;
    stream.getProtocol = () => 'TLSv1.3';
    stream.getCipher = () => ({ name: 'TLS_AES_256_GCM_SHA384' });
    client.stream = stream;
    client.emit('packetsend', { cmd: 'connect' });
    return stream;
}

function soundSwitch(env, platform) {
    const accessory = Object.values(platform.accessories).find(item => item.getService(env.Service.Switch));
    assert.ok(accessory, 'Account mode exposes the camera sound switch');
    return accessory.getService(env.Service.Switch).getCharacteristic(env.Characteristic.On);
}

function writeSwitch(characteristic, active) {
    const responses = [];
    characteristic.emit('set', active, error => responses.push(error));
    return responses;
}

function cameraMessage(client, suffix, body, cameraId = PRIVATE.cameraId) {
    client.emit('message', cameraId + '/' + suffix, Buffer.from(JSON.stringify(body)));
}

function music(client, playStatus) {
    cameraMessage(client, 'musicStatus/return', { result: { playStatus, privateField: PRIVATE.payload } });
}

test('the plugin debug setting reaches account callbacks, camera configuration and the live streaming delegate', async t => {
    const env = environment();
    t.after(() => env.api.emit('shutdown'));
    const original = JSON.stringify(env.config);
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const camera = [...platform.cameras.values()][0];
    assert.equal(platform.log.debugMode, true);
    assert.equal(camera.config.debug, true);
    assert.equal(camera.streamingDelegate.config.debug, true);
    assert.equal(camera.config.diagnosticRef, 'camera-1');
    assert.equal(JSON.stringify(env.config), original, 'Runtime diagnostics do not rewrite saved user settings');
    assert.equal(typeof env.account.options.diagnostics, 'function');
    assert.equal(typeof env.account.options.registerSecrets, 'function');
    assert.deepEqual(env.account.emitted, ['account.session', 'account.cameras', 'account.identity']);
    assert.ok(matching(env, 'platform.start', ['diagnosticsVersion=1', 'mode=account', 'nodeVersion=']).length === 1);
    assert.ok(matching(env, 'account.identity', ['source=cache', 'cameraRef=camera-1', 'cached=true']).length === 1);
    assert.ok(matching(env, 'platform.camera', ['cameraRef=camera-1', 'credentialsPresent=true']).length === 1);
    assert.ok(matching(env, 'mqtt.connection', ['phase=start', 'credentialsPresent=true', 'port=1883']).length === 1);
    platform.log.warn([PRIVATE.email, PRIVATE.password, PRIVATE.token, PRIVATE.cameraId, PRIVATE.address,
        PRIVATE.cert, PRIVATE.key, PRIVATE.mqttPassword, PRIVATE.signedUrl].join(' '));
    assertPrivateLogs(env);
});

test('MQTTS failures retain the TLS stage and retries show subscription denial followed by control readiness', async t => {
    const env = environment();
    t.after(() => env.api.emit('shutdown'));
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const camera = [...platform.cameras.values()][0];
    let refreshRequests = 0;
    camera.onAuthenticationFailure = () => { refreshRequests++; };
    const client = env.state.mqtt[0];
    const stream = attachTls(client);
    stream.emit('secureConnect');
    const failure = Object.assign(new Error(PRIVATE.payload + PRIVATE.signedUrl), { code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' });
    stream.emit('error', failure);
    client.emit('error', failure);
    assert.equal(matching(env, 'mqtt.connection', ['phase=failed', 'code=ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED']).length, 1);
    assert.ok(matching(env, 'mqtt.connection', ['phase=failed', 'stage="waiting for MQTT CONNECT acceptance"']).length === 1);
    assert.equal(refreshRequests, 1);
    assert.match(writeSwitch(soundSwitch(env, platform), true)[0].message, /unavailable/);

    client.emit('reconnect');
    const replacement = attachTls(client);
    replacement.emit('secureConnect');
    const subscribe = client.subscribe;
    client.subscribe = (topics, callback) => callback(null, topics.map(topic => ({ topic, qos: 128 })));
    client.emit('connect', { sessionPresent: false });
    assert.ok(matching(env, 'mqtt.tls', ['phase=start', 'attempt=2']).length === 1);
    assert.ok(matching(env, 'mqtt.tls', ['phase=secure', 'protocol=TLSv1.3', 'authorized=true']).length === 2);
    assert.ok(matching(env, 'mqtt.subscription', ['phase=failed', 'deniedCount=5', 'code=MQTT_SUBSCRIPTION_DENIED']).length === 1);
    assert.ok(matching(env, 'mqtt.subscription', ['phase=retry', 'delayMs=5000']).length === 1);
    assert.equal(camera.soundMachine.isConnected(), false);
    client.subscribe = subscribe;
    const timer = [...env.state.timers].find(([, value]) => value.delay === 5000);
    assert.ok(timer, 'A denied status subscription has a bounded retry');
    env.runTimer(timer[0]);
    assert.equal(camera.soundMachine.isConnected(), true);
    assert.ok(matching(env, 'mqtt.subscription', ['phase=complete', 'grantedCount=5', 'deniedCount=0']).length === 1);
    assert.ok(matching(env, 'sound.status', ['phase=connected', 'connected=true']).length === 1);
    assert.ok(matching(env, 'sound.status', ['phase=requested', 'knownState=false']).length === 1);
    assertPrivateLogs(env);
});

test('sound diagnostics distinguish publishing and camera acknowledgement from confirmed playback', async t => {
    const env = environment();
    t.after(() => env.api.emit('shutdown'));
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const client = env.state.mqtt[0];
    client.emit('connect');
    const characteristic = soundSwitch(env, platform);
    music(client, 'stop');
    const responses = writeSwitch(characteristic, true);
    assert.equal(responses.length, 0);
    assert.equal(matching(env, 'sound.command', ['phase=requested', 'commandId=1', 'requestedState=on']).length, 1);
    assert.equal(matching(env, 'sound.command', ['phase=published', 'commandId=1']).length, 1);
    assert.equal(matching(env, 'sound.command', ['phase=confirmed', 'commandId=1']).length, 0);
    cameraMessage(client, 'controlMusic/return', { id: 0, result: { status: 1, privateField: PRIVATE.payload } });
    assert.equal(matching(env, 'sound.command', ['phase=acknowledged', 'commandId=1']).length, 1);
    assert.equal(responses.length, 0, 'Acknowledging a request does not confirm the audio state');
    music(client, PRIVATE.payload);
    music(client, PRIVATE.payload);
    assert.equal(matching(env, 'sound.status', ['phase=ignored', 'reason=invalid_schema', 'playStatus=unknown', 'resultType=string']).length, 1);
    assert.equal(responses.length, 0, 'Unknown playback statuses cannot confirm the pending command');
    assert.equal(characteristic.value, false, 'Unknown playback statuses do not overwrite the last known switch state');
    music(client, 'pause');
    assert.equal(responses.length, 0);
    music(client, 'play');
    assert.deepEqual(responses, [null]);
    assert.equal(characteristic.value, true);
    const command = matching(env, 'sound.command', ['commandId=1']);
    assert.deepEqual(command.map(line => /phase=([a-z_]+)/.exec(line)[1]), ['requested', 'published', 'acknowledged', 'confirmed']);
    assert.ok(command.every(line => line.includes('cameraRef=camera-1')));
    assertPrivateLogs(env);
});

test('sound timeout and disconnect traces complete each request once and ignore late confirmations', async t => {
    const env = environment();
    t.after(() => env.api.emit('shutdown'));
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const client = env.state.mqtt[0];
    client.emit('connect');
    const characteristic = soundSwitch(env, platform);
    const timeout = writeSwitch(characteristic, false);
    const timer = [...env.state.timers].find(([, value]) => value.delay === 8000);
    assert.ok(timer);
    env.runTimer(timer[0]);
    assert.equal(timeout.length, 1);
    assert.match(timeout[0].message, /did not confirm/);
    cameraMessage(client, 'controlMusic/return', { result: { status: 1 } });
    music(client, 'pause');
    assert.equal(matching(env, 'sound.command', ['phase=timeout', 'reason=confirmation_timeout', 'commandId=1']).length, 1);
    assert.equal(matching(env, 'sound.command', ['phase=confirmed', 'commandId=1']).length, 0);
    const disconnected = writeSwitch(characteristic, true);
    client.emit('close');
    client.emit('offline');
    music(client, 'play');
    assert.equal(disconnected.length, 1);
    assert.match(disconnected[0].message, /unavailable/);
    assert.equal(matching(env, 'sound.command', ['phase=failed', 'reason=disconnected', 'commandId=2']).length, 1);
    assert.equal(matching(env, 'sound.command', ['phase=confirmed', 'commandId=2']).length, 0);
    assert.ok(matching(env, 'mqtt.connection', ['phase=close']).length === 1);
    assert.ok(matching(env, 'mqtt.connection', ['phase=offline']).length === 1);
    assertPrivateLogs(env);
});

test('repeated malformed, unexpected and wrong-camera messages are sampled without dumping topics or payloads', async t => {
    const env = environment();
    t.after(() => env.api.emit('shutdown'));
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const client = env.state.mqtt[0];
    for (let i = 0; i < 50; i++) cameraMessage(client, 'musicStatus/return', { result: PRIVATE.payload });
    client.emit('connect');
    for (let i = 0; i < 50; i++) {
        cameraMessage(client, 'musicStatus/return', { result: PRIVATE.payload }, PRIVATE.otherCamera);
        client.emit('message', PRIVATE.cameraId + '/musicStatus/return', Buffer.from(PRIVATE.payload + PRIVATE.signedUrl));
        cameraMessage(client, 'prenotify', { result: PRIVATE.payload });
        cameraMessage(client, PRIVATE.payload, { result: PRIVATE.payload });
    }
    for (const reason of ['not_ready', 'wrong_camera', 'invalid_json', 'invalid_schema', 'unknown_topic']) {
        assert.equal(matching(env, 'mqtt.message', ['reason=' + reason]).length, 1, 'Repeated messages should emit only the first diagnostic in each fixed category');
    }
    assert.ok(matching(env, 'mqtt.message').length <= 6, 'Two hundred fifty messages must produce only a few diagnostic records');
    assert.equal(client.publications.filter(item => item.topic.endsWith('/controlMusic')).length, 0);
    assertPrivateLogs(env);
});

test('debug off retains account setup and sound controls without emitting diagnostic records', async t => {
    const env = environment(false);
    t.after(() => env.api.emit('shutdown'));
    const platform = env.createPlatform(env.config);
    await platform.didFinishLaunching();
    const camera = [...platform.cameras.values()][0];
    assert.equal(camera.config.debug, false);
    assert.equal(camera.streamingDelegate.config.debug, false);
    const client = env.state.mqtt[0];
    attachTls(client).emit('secureConnect');
    client.emit('connect');
    const responses = writeSwitch(soundSwitch(env, platform), true);
    cameraMessage(client, 'controlMusic/return', { result: { status: 1 } });
    music(client, 'play');
    assert.deepEqual(responses, [null]);
    client.emit('message', PRIVATE.cameraId + '/musicStatus/return', Buffer.from(PRIVATE.payload));
    client.emit('close');
    platform.log.error(PRIVATE.email + ' ' + PRIVATE.token + ' ' + PRIVATE.key + ' ' + PRIVATE.mqttPassword);
    env.api.emit('shutdown');
    assert.ok(env.account.emitted.length > 0, 'Account instrumentation is wired even when its log output is disabled');
    assert.equal(diagnostics(env).length, 0);
    assertPrivateLogs(env);
});
