'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Logger } = require('../lib/logger');

test('all logger levels redact complete camera URLs and HomeKit stream keys', () => {
    for (const debugMode of [false, true]) {
        const messages = [];
        const sink = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, value => messages.push(value)]));
        const logger = new Logger(sink, debugMode);
        const input = 'ffmpeg -i rtsp://synthetic-user:pass%20word@127.0.0.1/live/opaque-path/ch00_0 -srtp_out_params synthetic-key';
        for (const level of ['info', 'warn', 'error', 'debug']) logger[level](input, 'Crib');
        assert.equal(messages.length, 4);
        for (const message of messages) {
            assert.match(message, /^\[Crib\]/);
            assert.match(message, /redacted camera URL/);
            for (const secret of ['synthetic-user', 'pass%20word', 'opaque-path', 'synthetic-key']) assert.ok(!message.includes(secret));
        }
    }
});

test('FFmpeg errors, RTSPS URLs, and SDP crypto keys are redacted', () => {
    const logger = new Logger({});
    const output = logger.formatMessage(new Error('401 on RTSPS://name:secret@camera.local/secret-path a=crypto:1 AES inline:stream-key'), 'Crib');
    assert.ok(!output.includes('name:secret'));
    assert.ok(!output.includes('secret-path'));
    assert.ok(!output.includes('stream-key'));
    assert.match(output, /401 on \[redacted camera URL\]/);
});

test('ordinary diagnostic messages remain readable', () => {
    const logger = new Logger({});
    assert.equal(logger.formatMessage('Camera connection failed after 15 seconds.', 'Crib'), '[Crib] Camera connection failed after 15 seconds.');
});

test('registered secrets are removed at every level in raw, JSON, URL and form encodings', () => {
    const messages = [];
    const sink = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, value => messages.push(value)]));
    const logger = new Logger(sink, true);
    const secret = 'synthetic pass+word/?@\\"\'!';
    const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
        encodeURIComponent(secret).replace(/%[A-F\d]{2}/g, match => match.toLowerCase()),
        encodeURIComponent(encodeURIComponent(secret)),
        new URLSearchParams({ v: secret }).toString().slice(2)];
    logger.addSecrets([secret, 'synthetic-camera-id', 'synthetic-session-token']);
    for (const level of ['info', 'warn', 'error', 'debug']) {
        for (const variant of variants) logger[level]('failure detail ' + variant, 'synthetic-camera-id');
        logger[level](new Error('request failed for synthetic-session-token'), 'Crib');
    }
    assert.equal(messages.length, 4 * (variants.length + 1));
    for (const output of messages) {
        for (const variant of variants) assert.ok(!output.includes(variant), output);
        assert.ok(!output.includes('synthetic-camera-id'));
        assert.ok(!output.includes('synthetic-session-token'));
        assert.match(output, /redacted/);
    }
});

test('headers, JSON credential fields, OTPs, and credential URLs are removed without registration', () => {
    const logger = new Logger({});
    const messages = [
        'Authorization: Bearer synthetic-bearer-token',
        'Proxy-Authorization: Basic synthetic-basic-token',
        'X-Parse-Session-Token: synthetic-parse-token',
        'Cookie: first=synthetic-cookie; second=synthetic-other-cookie',
        '{"password":"synthetic password","sessionToken":"synthetic-session","otp":"123456","hasPassword":true}',
        "password='synthetic password' verificationCode=987654",
        '{"email":"synthetic@example.test","cameraId":"synthetic-camera-id","pairingID":"synthetic-pairing-id"}',
        'download https://credentials.example.test/path?signature=synthetic-signed-token',
        'connect mqtts://synthetic-user:synthetic-mqtt-password@camera.local:1883/path',
        "download https://credentials.example.test/it's/a/path?signature=synthetic-signed-token",
        'https%3a%2f%2fcredentials.example.test%2fpath%3fsignature%3dsynthetic-encoded-token',
        'tool --password "synthetic CLI password" --otp 456789'
    ];
    for (const input of messages) {
        const output = logger.formatMessage(input);
        assert.ok(!output.includes('synthetic'), output);
        for (const code of ['123456', '987654', '456789']) assert.ok(!output.includes(code), output);
        assert.match(output, /redacted/);
    }
    assert.match(logger.formatMessage(messages[4]), /"hasPassword":true/);
    assert.equal(logger.formatMessage('hasPassword=true sessionTokenType=string cameraRef=camera-1'),
        'hasPassword=true sessionTokenType=string cameraRef=camera-1');
});

test('complete, escaped, and incomplete PEM blocks cannot appear in messages or errors', () => {
    const logger = new Logger({});
    logger.addSecrets(['PRIVATE', 'https']);
    const blocks = [
        '-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYMATERIAL\n-----END PRIVATE KEY-----',
        '-----BEGIN RSA PRIVATE KEY-----\\nSYNTHETICKEYMATERIAL\\n-----END RSA PRIVATE KEY-----',
        '-----BEGIN CERTIFICATE-----\nSYNTHETICCERTMATERIAL\n-----END CERTIFICATE-----',
        '-----BEGIN EC PRIVATE KEY-----\nSYNTHETICKEYMATERIAL'
    ];
    for (const block of blocks) {
        for (const input of [block, new Error('TLS failure: ' + block)]) {
            const output = logger.formatMessage(input);
            assert.ok(!output.includes('MATERIAL'));
            assert.ok(!output.includes('-----'));
            assert.match(output, /redacted PEM/);
        }
    }
    assert.ok(!logger.formatMessage('https://server.test/path?token=unregistered-secret').includes('unregistered-secret'));
});

test('unstructured objects and error internals are never serialized or evaluated', () => {
    const logger = new Logger({});
    let evaluated = 0;
    const value = {
        password: 'synthetic-private-value',
        toJSON() { evaluated++; throw new Error('Do not serialize'); },
        toString() { evaluated++; throw new Error('Do not stringify'); }
    };
    const output = logger.formatMessage(value, value);
    assert.equal(output, '[[object omitted]] [object omitted]');
    const error = new Error('Operation failed.');
    Object.defineProperty(error, 'stack', { get() { evaluated++; throw new Error('Do not read stack'); } });
    error.response = value;
    assert.equal(logger.formatMessage(error), 'Error: Operation failed.');
    const badMessage = new Error();
    Object.defineProperty(badMessage, 'message', { get() { evaluated++; return 'synthetic-private-value'; } });
    assert.equal(logger.formatMessage(badMessage), 'Error: [message omitted]');
    assert.equal(evaluated, 0);
});

test('messages remain one bounded log record after secret redaction', () => {
    const logger = new Logger({});
    const output = logger.formatMessage('Failure\r\nforged log\u001b[31m\u202e\tmore');
    assert.ok(!/[\r\n\u001b\u202e\t]/.test(output));
    assert.match(output, /Failure\\nforged log/);
    const long = logger.formatMessage('x'.repeat(20000));
    assert.ok(long.length < 8300);
    assert.match(long, /\[truncated\]$/);
});

test('a full secret registry fails closed without evicting old credentials', () => {
    const logger = new Logger({});
    const secrets = Array.from({ length: 256 }, (_, i) => 'synthetic-secret-' + i);
    logger.addSecrets(secrets);
    logger.addSecrets(['synthetic-secret-overflow']);
    assert.equal(logger.secrets.size, 256);
    const output = logger.formatMessage('synthetic-secret-0 synthetic-secret-overflow');
    assert.ok(!output.includes('synthetic-secret'));
    assert.match(output, /credential-redaction limit reached/);
    const tooLong = new Logger({});
    tooLong.addSecrets('s'.repeat(16385));
    assert.match(tooLong.formatMessage('message'), /credential-redaction limit reached/);
});

test('ordinary long PEM and its base64 cache encoding fit the bounded secret registry', () => {
    const logger = new Logger({});
    const pem = '-----BEGIN PRIVATE KEY-----\n' + 'SYNTHETIC'.repeat(1000) + '\n-----END PRIVATE KEY-----';
    const encoded = Buffer.from(pem).toString('base64');
    logger.addSecrets([pem, encoded]);
    assert.equal(logger.redactionSaturated, false);
    assert.equal(logger.formatMessage('Ordinary message after identity registration.'), 'Ordinary message after identity registration.');
    assert.ok(!logger.formatMessage('stored value ' + encoded).includes(encoded));
    assert.ok(!logger.formatMessage(pem).includes('SYNTHETIC'));
});

test('secret registration accepts only explicit string data without invoking getters', () => {
    const logger = new Logger({});
    let evaluated = 0;
    const values = [];
    Object.defineProperty(values, '0', { get() { evaluated++; return 'secret'; } });
    logger.addSecrets(values);
    logger.addSecrets({ toString() { evaluated++; return 'secret'; } });
    assert.equal(evaluated, 0);
    assert.equal(logger.formatMessage('ordinary log'), 'ordinary log');
});
