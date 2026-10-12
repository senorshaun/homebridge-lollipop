'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Logger } = require('../lib/logger');
const { emitDiagnostic, formatDiagnostic, safeErrorCode } = require('../lib/diagnostics');

test('diagnostics stay completely quiet when debug is off and use stable fields and sequence when on', () => {
    const messages = [];
    const logger = new Logger({ info: message => messages.push(message), debug: message => messages.push(message) }, false);
    emitDiagnostic(logger, 'account.request', { operation: 'login', phase: 'start', requestId: 1 });
    assert.deepEqual(messages, []);
    logger.debugMode = true;
    emitDiagnostic(logger, 'account.request', { requestId: 1, phase: 'start', operation: 'login' }, 'Crib');
    emitDiagnostic(logger, 'account.response', { statusCode: 200, requestId: 1, durationMs: 32, resultType: 'object' });
    assert.equal(messages[0], '[Crib] [diagnostic #1] account.request operation=login phase=start requestId=1');
    assert.equal(messages[1], '[diagnostic #2] account.response requestId=1 durationMs=32 statusCode=200 resultType=object');
    logger.debugMode = false;
    logger.diagnostic('account.request', { operation: 'cameras' });
    assert.equal(messages.length, 2);
});

test('the existing Homebridge debug flags also enable diagnostics', () => {
    for (const flag of ['-D', '--debug']) {
        process.argv.push(flag);
        try {
            const messages = [];
            const logger = new Logger({ info: message => messages.push(message) }, false);
            emitDiagnostic(logger, 'platform.start', { diagnosticsVersion: 1 });
            assert.equal(messages.length, 1);
            assert.match(messages[0], /platform.start diagnosticsVersion=1/);
        } finally { process.argv.pop(); }
    }
});

test('diagnostics reject event, enum, error-code, field-name and version injection', () => {
    const secret = 'synthetic-private-token';
    const output = formatDiagnostic('account.request\n' + secret, {
        operation: secret,
        phase: 'start\n' + secret,
        outcome: secret,
        errorCode: 'ERR_' + secret.toUpperCase(),
        reason: secret,
        password: secret,
        cameraId: secret,
        url: 'https://server.test/' + secret,
        response: { secret },
        pluginVersion: '1.2.3-' + secret,
        [secret]: secret
    }, 3);
    assert.match(output, /^\[diagnostic #3\] diagnostic.unknown /);
    assert.match(output, /operation=UNKNOWN/);
    assert.match(output, /errorCode=UNKNOWN/);
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(secret.toUpperCase()));
    assert.ok(!output.includes('password='));
    assert.ok(!output.includes('https:'));
    assert.ok(!output.includes('\n'));
});

test('diagnostics describe schema changes using types without accepting the actual payload', () => {
    const output = formatDiagnostic('account.response', {
        operation: 'mqtt_key', phase: 'failed', statusCode: 200, parseCode: 141,
        resultType: 'object', certType: 'undefined', keyType: 'array',
        certChecksumType: 'number', keyChecksumType: 'string',
        responseType: { secret: 'do-not-print' }, certBytes: Infinity,
        sessionTokenType: 'synthetic-session-token', hasSessionToken: true,
        timestampType: 'number', cameraRef: 'actual-camera-id'
    }, 1);
    assert.match(output, /operation=mqtt_key phase=failed/);
    assert.match(output, /statusCode=200 parseCode=141/);
    assert.match(output, /certType=undefined keyType=array/);
    assert.match(output, /sessionTokenType=UNKNOWN/);
    assert.ok(!output.includes('do-not-print'));
    assert.ok(!output.includes('synthetic-session-token'));
    assert.ok(!output.includes('actual-camera-id'));
    assert.ok(!output.includes('Infinity'));
});

test('known connection failures remain actionable but arbitrary codes are never copied', () => {
    assert.equal(safeErrorCode(4), 'MQTT_CONNACK_4');
    assert.equal(safeErrorCode(5), 'MQTT_CONNACK_5');
    assert.equal(safeErrorCode('ECONNREFUSED'), 'ECONNREFUSED');
    assert.equal(safeErrorCode('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'), 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED');
    assert.equal(safeErrorCode('CHECKSUM_MISMATCH'), 'CHECKSUM_MISMATCH');
    assert.equal(safeErrorCode('ERR_SECRET_SESSION_TOKEN'), 'UNKNOWN');
    assert.equal(safeErrorCode({ code: 'ECONNREFUSED', token: 'secret' }), 'UNKNOWN');
    assert.equal(safeErrorCode(123456), 'UNKNOWN');
});

test('diagnostics never invoke payload getters, inherited fields, toJSON, or toString', () => {
    let evaluated = 0;
    const fields = Object.create({ operation: 'login' });
    Object.defineProperty(fields, 'code', { get() { evaluated++; return 'ECONNREFUSED'; } });
    fields.response = { toJSON() { evaluated++; throw new Error('secret'); } };
    fields.reason = { toString() { evaluated++; throw new Error('secret'); } };
    assert.equal(formatDiagnostic('account.request', fields, 1), '[diagnostic #1] account.request');
    assert.equal(evaluated, 0);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private payload'); } });
    assert.equal(formatDiagnostic('account.request', proxy, 1), '[diagnostic #1] account.request');
});

test('diagnostics cannot throw into the application when a logger or payload fails', () => {
    const faulty = { diagnostic() { throw new Error('synthetic secret'); } };
    const getter = Object.defineProperty({}, 'diagnostic', { get() { throw new Error('synthetic secret'); } });
    for (const logger of [undefined, {}, faulty, getter, new Logger({ info() { throw new Error('log sink unavailable'); } }, true)]) {
        assert.doesNotThrow(() => emitDiagnostic(logger, 'account.request', { phase: 'start' }));
    }
});

test('runtime, TLS, camera and stream correlation metadata are useful without addresses or IDs', () => {
    const runtime = formatDiagnostic('platform.start', {
        pluginVersion: '0.0.1-beta.4', nodeVersion: 'v24.19.0', homebridgeVersion: '1.11.0',
        mqttVersion: '4.2.8', opensslVersion: '3.5.7', platform: 'linux', arch: 'arm64',
        mode: 'account', diagnosticsVersion: 1
    }, 1);
    assert.match(runtime, /pluginVersion=0.0.1-beta.4/);
    assert.match(runtime, /nodeVersion=v24.19.0/);
    assert.match(runtime, /platform=linux arch=arm64/);
    const mqtt = formatDiagnostic('mqtt.connection', {
        phase: 'connected', cameraRef: 'camera-1', hostType: 'ipv4',
        protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', authorized: true,
        address: '192.0.2.1', cameraId: 'synthetic-camera'
    }, 2);
    assert.match(mqtt, /cameraRef=camera-1/);
    assert.match(mqtt, /protocol=TLSv1.3 cipher=TLS_AES_256_GCM_SHA384/);
    assert.ok(!mqtt.includes('192.0.2.1'));
    assert.ok(!mqtt.includes('synthetic-camera'));
    assert.match(formatDiagnostic('media', { operation: 'stream', streamRef: 'stream-2', width: 1280, height: 720 }, 3),
        /operation=stream streamRef=stream-2 width=1280 height=720/);
});

test('known secrets are also scrubbed from otherwise valid diagnostic enum values and device labels', () => {
    const messages = [];
    const logger = new Logger({ info: message => messages.push(message) }, true);
    logger.addSecrets(['Crib private label', 'login']);
    emitDiagnostic(logger, 'account.request', { operation: 'login', requestId: 1 }, 'Crib private label');
    assert.equal(messages.length, 1);
    assert.ok(!messages[0].includes('Crib private label'));
    assert.ok(!messages[0].includes('login'));
});

test('strict diagnostics survive registry saturation while raw logs and device labels remain private', () => {
    const messages = [];
    const logger = new Logger({ info: message => messages.push(message), error: message => messages.push(message) }, true);
    logger.addSecrets(['camera-1', 'synthetic-session-secret']);
    const enormousPem = '-----BEGIN PRIVATE KEY-----\n' + 'SYNTHETICPRIVATE'.repeat(2000) + '\n-----END PRIVATE KEY-----';
    logger.addSecrets([enormousPem, Buffer.from(enormousPem).toString('base64')]);
    assert.equal(logger.redactionSaturated, true);
    logger.error('synthetic-session-secret ' + enormousPem, 'private device label');
    emitDiagnostic(logger, 'mqtt.connection', {
        phase: 'failed', stage: 'TLS handshake', cameraRef: 'camera-1',
        code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', attempt: 2,
        durationMs: 82, privateKey: enormousPem, payload: { token: 'unregistered-secret' }
    }, 'private device label');
    assert.match(messages[0], /credential-redaction limit reached/);
    assert.match(messages[1], /mqtt.connection phase=failed stage="TLS handshake"/);
    assert.match(messages[1], /code=ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED/);
    assert.match(messages[1], /durationMs=82 attempt=2/);
    assert.match(messages[1], /redactionLimited=true/);
    for (const message of messages) {
        assert.ok(!message.includes('private device label'));
        assert.ok(!message.includes('SYNTHETICPRIVATE'));
        assert.ok(!message.includes('unregistered-secret'));
        assert.ok(!message.includes('synthetic-session-secret'));
        assert.ok(!message.includes('camera-1'));
    }
});
