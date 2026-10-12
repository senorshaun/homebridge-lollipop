'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { createEnvironment } = require('./helpers.cjs');

const rtspUrl = 'rtsp://synthetic-user:synthetic%40password@192.0.2.10:554/live/35c3d6ad9f13c46ca9bc3b125be8d8c8/ch00_0';

test('direct authenticated video starts without MQTT and preserves the recovered URL through FFmpeg input', async () => {
  const env = createEnvironment();
  const { config } = env.createCamera({ rtspUrl });

  assert.equal(env.state.mqtt.length, 0);
  assert.equal(env.state.controllers.length, 1);
  assert.equal(config.ip, '192.0.2.10');
  const delegate = env.state.controllers[0].options.delegate;
  await delegate.fetchSnapshot('');
  const { args } = env.state.spawns[0];
  assert.equal(args[args.indexOf('-i') + 1], rtspUrl);
  assert.equal(env.state.mqtt.length, 0);
});

test('direct video removes cached MQTT capabilities and does not advertise HKSV', () => {
  const env = createEnvironment();
  const name = 'Cached camera';
  const accessory = new env.TestAccessory(name);
  const sensorNames = [
    'Movement Sensor', 'Crying Detection Sensor', 'Crossing Detection Sensor',
    'Noise Sensor', 'HKSV Sensor',
  ];
  for (const sensorName of sensorNames) {
    accessory.addService(env.Service.MotionSensor, sensorName, sensorName);
  }
  const soundUUID = env.generateUUID(name + ' Sound Machine');
  const soundMachine = new env.TestAccessory(name + ' Sound Machine', soundUUID);
  const { config } = env.createCamera({
    name, rtspUrl, hksv: true, prebuffer: true, movementSensitivity: 1,
    enableCryingDetectionSensor: true, enableCrossingDetectionSensor: true,
    enableNoiseSensor: true, enableSoundMachine: true,
  }, { accessory, accessories: { [soundUUID]: soundMachine } });

  assert.equal(env.state.mqtt.length, 0);
  assert.equal(env.state.controllers.length, 1);
  assert.equal(config.hksv, false);
  assert.equal(config.prebuffer, false);
  assert.equal(env.state.recordingDelegates.length, 0);
  assert.equal(env.state.soundMachines.length, 0);
  assert.equal(env.state.controllers[0].options.recording, undefined);
  for (const sensorName of sensorNames) assert.equal(accessory.getService(sensorName), undefined);
  assert.equal(env.state.unregistered.length, 1);
  assert.deepEqual(Array.from(env.state.unregistered[0][2]), [soundMachine]);
});

for (const unbridge of [false, true]) {
  test('invalid direct URL is rejected before publishing a new ' + (unbridge ? 'unbridged' : 'bridged') + ' camera', () => {
    const env = createEnvironment();
    const platform = env.createPlatform({
      lollipops: [{ name: 'Invalid camera', rtspUrl: 'rtsp://user@192.0.2.10/live', unbridge }],
    });
    platform.didFinishLaunching();
    assert.equal(env.state.registered.length, 0);
    assert.equal(env.state.published.length, 0);
    assert.equal(env.state.controllers.length, 0);
    assert.equal(env.state.mqtt.length, 0);
  });
}

for (const [label, badUrl, ip] of [
  ['wrong scheme', 'https://user:private-invalid-password@192.0.2.10/live', undefined],
  ['missing authentication', 'rtsp://192.0.2.10/live', undefined],
  ['missing password', 'rtsp://user@192.0.2.10/live', undefined],
  ['raw space in credentials', 'rtsp://user:private-invalid-password @192.0.2.10/live', undefined],
  ['raw control character', 'rtsp://user:private-invalid-password@192.0.2.10/live\n', undefined],
  ['host mismatch', 'rtsp://user:private-invalid-password@192.0.2.10/live', '192.0.2.11'],
]) {
  test('invalid direct configuration fails before connecting: ' + label, () => {
    const env = createEnvironment();
    assert.doesNotThrow(() => env.createCamera({ rtspUrl: badUrl, ...(ip ? { ip } : {}) }));
    assert.equal(env.state.mqtt.length, 0);
    assert.equal(env.state.controllers.length, 0);
    assert.ok(env.state.logs.some(entry => entry.level === 'error'));
    assert.ok(!JSON.stringify(env.state.logs).includes('private-invalid-password'));
  });
}

test('an explicit legacy pairing ID skips discovery while retaining the MQTT status client', () => {
  const env = createEnvironment();
  const pairingID = 'pairing-123';
  const { config } = env.createCamera({ ip: '192.0.2.10', pairingID });
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 1);
  const hash = crypto.createHash('md5').update(pairingID).digest('hex');
  assert.ok(config.source.includes('/live/' + hash + '/ch00_0'));
  env.state.mqtt[0].emit('connect');
  assert.ok(!env.state.mqtt[0].subscriptions.includes('#'));
  assert.ok(env.state.mqtt[0].subscriptions.flat().includes(pairingID + '/liveNote'));
});

test('legacy discovery configures exactly once when multiple discovery messages reach the callback', () => {
  const env = createEnvironment();
  env.createCamera({ ip: '192.0.2.10' });
  assert.equal(env.state.controllers.length, 0);
  assert.equal(env.state.mqtt.length, 1);
  const discovery = env.state.mqtt[0];
  discovery.emit('connect');
  assert.ok(discovery.subscriptions.includes('#'));
  discovery.emit('message', 'pairing-123/liveNote', Buffer.from('{}'));
  discovery.emit('message', 'pairing-123/musicStatus/return', Buffer.from('{}'));
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 2);
  assert.equal(discovery.endCalls, 1);
  assert.equal(env.state.timers.size, 0);
});

test('legacy discovery closes on connection failure and ignores late messages', () => {
  const env = createEnvironment();
  env.createCamera({ ip: '192.0.2.10' });
  const discovery = env.state.mqtt[0];
  assert.doesNotThrow(() => discovery.emit('error', new Error('synthetic MQTT failure')));
  assert.equal(discovery.endCalls, 1);
  discovery.emit('message', 'pairing-123/liveNote', Buffer.from('{}'));
  assert.equal(env.state.controllers.length, 0);
  assert.equal(env.state.mqtt.length, 1);
  assert.equal(env.state.timers.size, 0);
  assert.ok(env.state.logs.some(entry => entry.level === 'error' || entry.level === 'warn'));
});

test('legacy discovery has a bounded timeout and ignores messages after it expires', () => {
  const env = createEnvironment();
  env.createCamera({ ip: '192.0.2.10' });
  const discovery = env.state.mqtt[0];
  const timeout = [...env.state.timers].find(([, timer]) => timer.delay === 15000);
  assert.ok(timeout, 'Discovery must schedule its 15 second timeout');
  env.runTimer(timeout[0]);
  assert.equal(discovery.endCalls, 1);
  discovery.emit('message', 'pairing-123/liveNote', Buffer.from('{}'));
  assert.equal(env.state.controllers.length, 0);
  assert.equal(env.state.mqtt.length, 1);
  assert.equal(env.state.timers.size, 0);
});

test('two cameras keep independent motion-reset timers', () => {
  const env = createEnvironment();
  const first = env.createCamera({ name: 'First', ip: '192.0.2.10', pairingID: 'first-id', movementSensitivity: 1 });
  const second = env.createCamera({ name: 'Second', ip: '192.0.2.11', pairingID: 'second-id', movementSensitivity: 1 });
  const firstSensor = first.accessory.getService('Movement Sensor');
  const secondSensor = second.accessory.getService('Movement Sensor');
  const motionMessage = Buffer.from('{"result":{"motion":50}}');

  first.lollipop.liveNoteHandler(motionMessage);
  const firstTimer = [...env.state.timers.keys()][0];
  second.lollipop.liveNoteHandler(motionMessage);
  assert.equal(firstSensor.value, true);
  assert.equal(secondSensor.value, true);
  assert.equal(env.state.timers.size, 2, 'Second camera must not clear the first camera timer');
  env.runTimer(firstTimer);
  assert.equal(firstSensor.value, false);
  assert.equal(secondSensor.value, true);
  env.runTimer([...env.state.timers.keys()][0]);
  assert.equal(secondSensor.value, false);
});
