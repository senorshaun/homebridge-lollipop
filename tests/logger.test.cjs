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
