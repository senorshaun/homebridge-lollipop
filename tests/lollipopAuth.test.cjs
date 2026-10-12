'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEnvironment } = require('./helpers.cjs');

const cameraId = 'synthetic-pairing-id';
const ip = '192.0.2.10';
const derivedUrl = 'rtsp://homebridge:325816c6351dfc0abb3a0cf9c2542c8e@192.0.2.10:554/live/45fd3b2027f096986fb09a706376d715/ch00_0';

test('a raw camera ID starts authenticated streaming without MQTT and reaches the actual snapshot delegate', async () => {
  const env = createEnvironment();
  const { config, suppliedConfig, accessory } = env.createCamera({ cameraId, ip, rtspUrl: '' });
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 0);
  assert.equal(config.pairingID, cameraId);
  assert.equal(config.source, '-rtsp_transport tcp -i ' + derivedUrl);
  assert.equal(suppliedConfig.source, undefined, 'Runtime must not rewrite the supplied configuration');
  assert.equal(accessory.getService(env.Service.AccessoryInformation).getCharacteristic(env.Characteristic.SerialNumber).value, cameraId);

  await env.state.controllers[0].options.delegate.fetchSnapshot('');
  const { args } = env.state.spawns[0];
  assert.equal(args[args.indexOf('-i') + 1], derivedUrl);
  assert.equal(env.state.mqtt.length, 0);
});

test('derived credentials are redacted by the real platform logger during snapshot startup', async () => {
  const env = createEnvironment();
  const platform = env.createPlatform({
    debug: true,
    lollipops: [{ name: 'Derived camera', cameraId, ip }],
  });
  platform.didFinishLaunching();
  assert.equal(env.state.controllers.length, 1);
  await env.state.controllers[0].options.delegate.fetchSnapshot('');
  assert.equal(env.state.spawns.length, 1);
  assert.ok(env.state.logs.length > 0);
  assert.ok(!JSON.stringify(env.state.logs).includes('325816c6351dfc0abb3a0cf9c2542c8e'));
});

test('derived direct mode removes cached MQTT features and omits HKSV even if previously enabled', () => {
  const env = createEnvironment();
  const name = 'Recovered auth camera';
  const accessory = new env.TestAccessory(name);
  const sensorNames = [
    'Movement Sensor', 'Crying Detection Sensor', 'Crossing Detection Sensor',
    'Noise Sensor', 'HKSV Sensor',
  ];
  for (const sensorName of sensorNames) accessory.addService(env.Service.MotionSensor, sensorName, sensorName);
  const soundUUID = env.generateUUID(name + ' Sound Machine');
  const soundMachine = new env.TestAccessory(name + ' Sound Machine', soundUUID);
  const { config } = env.createCamera({
    name, cameraId, ip, hksv: true, prebuffer: true, movementSensitivity: 1,
    enableCryingDetectionSensor: true, enableCrossingDetectionSensor: true,
    enableNoiseSensor: true, enableSoundMachine: true,
  }, { accessory, accessories: { [soundUUID]: soundMachine } });

  assert.equal(config.hksv, false);
  assert.equal(config.prebuffer, false);
  assert.equal(env.state.mqtt.length, 0);
  assert.equal(env.state.recordingDelegates.length, 0);
  assert.equal(env.state.soundMachines.length, 0);
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.controllers[0].options.recording, undefined);
  for (const sensorName of sensorNames) assert.equal(accessory.getService(sensorName), undefined);
  assert.equal(env.state.unregistered.length, 1);
  assert.deepEqual(Array.from(env.state.unregistered[0][2]), [soundMachine]);
});

test('runtime preserves explicit recovered URLs when camera-ID credentials are also configured', () => {
  const env = createEnvironment();
  const rtspUrl = 'rtsp://recovered:opaque-password@192.0.2.10:8554/different/path?quality=2';
  const { config } = env.createCamera({ cameraId, ip, rtspUsername: 'alt-user', rtspUrl });
  assert.equal(config.source, '-rtsp_transport tcp -i ' + rtspUrl);
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 0);
});

test('invalid derived configuration fails before camera setup or MQTT fallback', () => {
  for (const change of [
    { cameraId: 'invalid:id' }, { cameraId: ' ' }, { cameraId: 123 },
    { ip: 'rtsp://192.0.2.10' }, { ip: '192.0.2.10:554' }, { ip: '' },
    { rtspUsername: 'invalid:user' },
  ]) {
    const env = createEnvironment();
    assert.doesNotThrow(() => env.createCamera({ cameraId, ip, ...change }));
    assert.equal(env.state.controllers.length, 0);
    assert.equal(env.state.mqtt.length, 0);
    assert.ok(env.state.logs.some(entry => entry.level === 'error'));
  }
});

for (const unbridge of [false, true]) {
  const mode = unbridge ? 'unbridged' : 'bridged';

  test('platform validates derived credentials before publishing a ' + mode + ' camera', () => {
    for (const change of [
      { cameraId: 'invalid:id' }, { cameraId: ' ' }, { cameraId: 123 },
      { ip: '192.0.2.10:554' }, { ip: '' }, { rtspUsername: 'invalid:user' },
      { rtspUrl: 'rtsp://192.0.2.10/live' },
    ]) {
      const env = createEnvironment();
      const platform = env.createPlatform({
        lollipops: [{ name: 'Invalid derived camera', cameraId, ip, unbridge, ...change }],
      });
      assert.doesNotThrow(() => platform.didFinishLaunching());
      assert.equal(env.state.registered.length, 0);
      assert.equal(env.state.published.length, 0);
      assert.equal(env.state.controllers.length, 0);
      assert.equal(env.state.mqtt.length, 0);
    }
  });

  test('platform publishes a valid derived ' + mode + ' camera without MQTT', () => {
    const env = createEnvironment();
    const platform = env.createPlatform({
      lollipops: [{ name: 'Derived camera', cameraId, ip, unbridge }],
    });
    platform.didFinishLaunching();
    assert.equal(env.state.controllers.length, 1);
    assert.equal(env.state.mqtt.length, 0);
    assert.equal(env.state.published.length, unbridge ? 1 : 0);
    assert.equal(env.state.registered.length, unbridge ? 0 : 1);
  });
}
