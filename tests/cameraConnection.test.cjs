'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveCameraConnection, hasDirectStreamConfig } = require('../lib/cameraConnection');

// Fixed synthetic vectors calculated independently with Python hashlib. In
// particular, these distinguish UTF-8 text hashing from decoding hex inputs,
// omitting separators, lowercasing the recovered constant, or hashing an ID twice.
const defaultConfig = { cameraId: 'synthetic-pairing-id', ip: '192.0.2.10' };
const defaultUrl = 'rtsp://homebridge:325816c6351dfc0abb3a0cf9c2542c8e@192.0.2.10:554/live/45fd3b2027f096986fb09a706376d715/ch00_0';
const sourcePrefix = '-rtsp_transport tcp -i ';

function parsedSource(connection) {
  assert.ok(connection.source.startsWith(sourcePrefix));
  return new URL(connection.source.slice(sourcePrefix.length));
}

test('recovered authentication matches an independent fixed vector and preserves the raw pairing ID', () => {
  const config = { ...defaultConfig };
  const connection = resolveCameraConnection(config);
  assert.equal(connection.source, sourcePrefix + defaultUrl);
  assert.equal(connection.ip, '192.0.2.10');
  assert.equal(connection.pairingID, 'synthetic-pairing-id');
  assert.deepEqual(config, defaultConfig, 'Resolving a connection must not mutate caller configuration');
});

test('an empty username left by the configuration UI uses the homebridge default', () => {
  assert.equal(resolveCameraConnection({ ...defaultConfig, rtspUsername: '' }).source, sourcePrefix + defaultUrl);
});

test('camera IDs and usernames are case-sensitive hash inputs', () => {
  const idCase = parsedSource(resolveCameraConnection({ ...defaultConfig, cameraId: 'Synthetic-pairing-id' }));
  assert.equal(idCase.password, 'e417ee7afe195fa86ac92d7826a78ad4');
  assert.equal(idCase.pathname, '/live/cafda1fd689a13dd8c0b7ee3626575c0/ch00_0');

  const userCase = parsedSource(resolveCameraConnection({ ...defaultConfig, rtspUsername: 'Homebridge' }));
  assert.equal(userCase.username, 'Homebridge');
  assert.equal(userCase.password, '0e2036ea71c2da812f2155588087152b');
  assert.equal(userCase.pathname, '/live/45fd3b2027f096986fb09a706376d715/ch00_0');
});

test('username characters are hashed before URL encoding and cannot change the stream destination', () => {
  const username = 'nursery @/?#%+&=';
  const connection = resolveCameraConnection({ ...defaultConfig, rtspUsername: username });
  const url = parsedSource(connection);
  assert.equal(decodeURIComponent(url.username), username);
  assert.equal(url.password, '0928c87652664e3c5a90640cb41b5c4b');
  assert.equal(url.hostname, '192.0.2.10');
  assert.equal(url.port, '554');
  assert.equal(url.pathname, '/live/45fd3b2027f096986fb09a706376d715/ch00_0');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(!/\s/.test(connection.source.slice(sourcePrefix.length)), 'The complete URL must remain one FFmpeg argument');
});

test('non-ASCII pairing IDs use UTF-8 for both hashes', () => {
  const url = parsedSource(resolveCameraConnection({ ...defaultConfig, cameraId: 'camera-ñ-1' }));
  assert.equal(url.password, '21cd5e904c30f199bdd7413c2aba5438');
  assert.equal(url.pathname, '/live/7f0175d7d7f1c10a114093d21f1d2d08/ch00_0');
});

test('derived authentication accepts a hostname and either normal IPv6 representation', () => {
  for (const [ip, expectedHostname] of [
    ['nursery-camera.local', 'nursery-camera.local'],
    ['2001:db8::10', '[2001:db8::10]'],
    ['[2001:db8::10]', '[2001:db8::10]'],
  ]) {
    const url = parsedSource(resolveCameraConnection({ ...defaultConfig, ip }));
    assert.equal(url.hostname, expectedHostname);
    assert.equal(url.port, '554');
    assert.equal(url.password, '325816c6351dfc0abb3a0cf9c2542c8e');
  }
});

test('camera IDs reject missing values, delimiters, whitespace, controls, and non-string values', () => {
  for (const cameraId of [undefined, null, '', ' ', 'id with space', 'id\tpart', 'id\npart', 'id\u007fpart', 'id:part', 123, {}]) {
    assert.throws(() => resolveCameraConnection({ ...defaultConfig, cameraId }), undefined, 'Invalid camera ID must fail');
  }
});

test('derived host validation rejects URLs, ports, credentials, paths, and malformed hosts', () => {
  for (const ip of [
    undefined, null, '', ' ', 123, {},
    'rtsp://192.0.2.10', 'http://camera.local', '192.0.2.10:554', 'camera.local:554',
    'user@camera.local', 'camera.local/live', 'camera.local?stream=1', 'camera.local#fragment',
    'camera.local\\live', 'camera .local', 'camera.local\n', '[2001:db8::10]:554', '[2001:db8::10',
  ]) {
    assert.throws(() => resolveCameraConnection({ ...defaultConfig, ip }), undefined, 'Invalid camera host must fail');
  }
});

test('username validation rejects ambiguous digest delimiters, controls, and unusable values', () => {
  for (const rtspUsername of [' ', '\t', 'user:name', 'user\nname', 'user\u0000name', 'user\u007fname', 123, {}]) {
    assert.throws(() => resolveCameraConnection({ ...defaultConfig, rtspUsername }), undefined, 'Invalid RTSP username must fail');
  }
});

test('an explicit authenticated URL takes priority over derived credentials and preserves its opaque path', () => {
  const rtspUrl = 'rtsp://recovered-user:recovered%40password@192.0.2.10:8554/custom/AbCd?profile=2%2Fmain';
  const connection = resolveCameraConnection({
    ...defaultConfig, cameraId: 'invalid:id', rtspUsername: 'invalid:user', rtspUrl,
  });
  assert.equal(connection.source, sourcePrefix + rtspUrl);
  assert.equal(connection.ip, '192.0.2.10');
});

test('an invalid explicit URL cannot silently fall back to derived credentials', () => {
  assert.throws(() => resolveCameraConnection({ ...defaultConfig, rtspUrl: 'rtsp://192.0.2.10/live' }));
  assert.throws(() => resolveCameraConnection({ ...defaultConfig, rtspUrl: ' ' }));
});

test('an empty explicit URL allows derived configuration and legacy pairingID does not opt into it', () => {
  assert.equal(resolveCameraConnection({ ...defaultConfig, rtspUrl: '' }).source, sourcePrefix + defaultUrl);
  assert.throws(() => resolveCameraConnection({ ip: '192.0.2.10', pairingID: 'synthetic-pairing-id' }));

  assert.equal(hasDirectStreamConfig({}), false);
  assert.equal(hasDirectStreamConfig({ rtspUrl: '', cameraId: '' }), false);
  assert.equal(hasDirectStreamConfig({ pairingID: 'synthetic-pairing-id' }), false);
  assert.equal(hasDirectStreamConfig(defaultConfig), true);
  assert.equal(hasDirectStreamConfig({ rtspUrl: defaultUrl }), true);
  assert.equal(hasDirectStreamConfig({ cameraId: ' ' }), true, 'Invalid populated direct configuration must still be validated');
});
