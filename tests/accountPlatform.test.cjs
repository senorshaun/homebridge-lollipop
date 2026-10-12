'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEnvironment } = require('./helpers.cjs');

function environment(options = {}) {
  const account = {
    records: [{ cameraId: 'synthetic-camera', name: 'Nursery', ip: '192.0.2.40' }],
    credentials: { cert: Buffer.from('synthetic-client-cert'), key: Buffer.from('synthetic-private-key') },
    calls: [], lastCameraSource: 'cloud',
    async authenticate() { this.calls.push('authenticate'); if (this.authError) throw this.authError; return { authenticated: true }; },
    async listCameras() { this.calls.push('list'); if (this.listError) throw this.listError; return this.records; },
    async getMqttCredentials(cameraId, settings) { this.calls.push({ cameraId, settings }); if (this.keyError) throw this.keyError; return this.credentials; },
    close() { this.closed = true; },
  };
  class Account { constructor(config) { account.config = config; return account; } }
  const env = createEnvironment({
    Account, realSoundMachine: true,
    mqttAuth: { createAuthenticatedMqttOptions: ({ cameraId, cert, key }) => ({
      username: 'lollipop', password: 'synthetic-mqtt-password-' + cameraId,
      cert, key, ca: 'synthetic-ca', rejectUnauthorized: true,
    }) },
    ...options,
  });
  const config = { account: { email: 'owner@example.test' } };
  return { ...env, account, config };
}

function soundSwitch(env, platform) {
  const accessory = Object.values(platform.accessories).find(item => item.getService(env.Service.Switch));
  assert.ok(accessory, 'The account setup must expose its sound switch');
  return accessory.getService(env.Service.Switch).getCharacteristic(env.Characteristic.On);
}
const music = (client, status, cameraId = 'synthetic-camera') => client.emit('message', cameraId + '/musicStatus/return',
  Buffer.from('42["musicStatus",' + JSON.stringify({ result: { playStatus: status, countdownTimer: 600 } }) + ']'));

function writeSwitch(characteristic, active) {
  const responses = [];
  characteristic.emit('set', active, error => responses.push(error));
  return responses;
}

test('account-only setup discovers the address and ID, derives video, and uses its authenticated client for the switch', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  assert.equal(env.account.config.storagePath, '/synthetic-homebridge-storage/lollipop');
  assert.equal(env.config.lollipops, undefined);
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 1);
  const client = env.state.mqtt[0];
  assert.equal(client.url, 'mqtts://192.0.2.40:1883');
  assert.equal(client.options.username, 'lollipop');
  assert.equal(client.options.key, env.account.credentials.key);
  assert.equal(client.options.rejectUnauthorized, true);
  assert.equal(client.options.queueQoSZero, false);
  assert.match([...platform.cameras.values()][0].config.source, /^-rtsp_transport tcp -i rtsp:\/\/homebridge:[a-f\d]{32}@192\.0\.2\.40:554\/live\/[a-f\d]{32}\/ch00_0$/);
  const characteristic = soundSwitch(env, platform);
  assert.match(writeSwitch(characteristic, true)[0].message, /unavailable/);
  assert.equal(client.publications.length, 0);
  client.emit('connect');
  assert.ok(client.subscriptions.flat().includes('synthetic-camera/controlMusic/return'));
  assert.equal(client.publications[0].topic, 'synthetic-camera/musicStatus');
  music(client, 'stop');
  const responses = writeSwitch(characteristic, true);
  const command = client.publications.find(item => item.topic.endsWith('/controlMusic'));
  assert.deepEqual(JSON.parse(command.payload), {
    method: 'controlMusic', params: { playStatus: 'play', countdownTimer: 600, repeatStatus: 'one' }, id: 0,
  });
  assert.equal(command.options.qos, 0);
  assert.equal(command.options.retain, false);
  assert.equal(responses.length, 0, 'Sending bytes alone does not prove the camera changed state');
  music(client, 'play', 'different-camera');
  assert.equal(responses.length, 0, 'An unrelated camera cannot confirm the command');
  client.emit('message', 'synthetic-camera/musicStatus/return', Buffer.from('bad-message'));
  assert.equal(responses.length, 0);
  music(client, 'play');
  assert.deepEqual(responses, [null]);
  assert.equal(characteristic.value, true);
  assert.doesNotMatch(JSON.stringify(env.state.logs), /synthetic-private-key|synthetic-client-cert|synthetic-mqtt-password/);
  assert.doesNotMatch(JSON.stringify(Object.values(platform.accessories).map(item => item.context)), /private-key|password|CERTIFICATE/);
  env.api.emit('shutdown');
});

test('sound commands fail once on disconnect, do not queue, and query status again after reconnect', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  const client = env.state.mqtt[0];
  client.emit('connect');
  const characteristic = soundSwitch(env, platform);
  music(client, 'stop');
  const first = writeSwitch(characteristic, true);
  client.emit('close');
  assert.equal(first.length, 1);
  assert.match(first[0].message, /unavailable/);
  music(client, 'play');
  assert.equal(first.length, 1);
  const before = client.publications.length;
  assert.match(writeSwitch(characteristic, false)[0].message, /unavailable/);
  assert.equal(client.publications.length, before);
  client.emit('connect');
  assert.equal(client.publications[before].topic, 'synthetic-camera/musicStatus');
  assert.equal(client.publications.filter(item => item.topic.endsWith('/controlMusic')).length, 1);
  music(client, 'play');
  const stop = writeSwitch(characteristic, false);
  assert.equal(JSON.parse(client.publications.filter(item => item.topic.endsWith('/controlMusic')).at(-1).payload).params.playStatus, 'pause');
  music(client, 'pause');
  assert.deepEqual(stop, [null]);
  env.api.emit('shutdown');
});

test('camera rejection, publish errors, and missing state confirmation produce bounded switch errors', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  const client = env.state.mqtt[0];
  client.emit('connect');
  const characteristic = soundSwitch(env, platform);
  let responses = writeSwitch(characteristic, true);
  client.emit('message', 'synthetic-camera/controlMusic/return', Buffer.from('{"id":0,"result":{"status":0}}'));
  assert.equal(responses.length, 1);
  assert.match(responses[0].message, /rejected/);
  responses = writeSwitch(characteristic, true);
  const timer = [...env.state.timers].find(([, value]) => value.delay === 8000);
  assert.ok(timer);
  env.runTimer(timer[0]);
  assert.equal(responses.length, 1);
  assert.match(responses[0].message, /did not confirm/);
  const publish = client.publish;
  client.publish = (topic, payload, options, callback) => callback(new Error('synthetic-secret-from-socket'));
  responses = writeSwitch(characteristic, true);
  assert.equal(responses.length, 1);
  assert.match(responses[0].message, /Could not send/);
  assert.doesNotMatch(responses[0].message, /synthetic-secret/);
  client.publish = publish;
  env.api.emit('shutdown');
});

test('denied status subscriptions keep the sound switch unavailable', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  const client = env.state.mqtt[0];
  const subscribe = client.subscribe;
  client.subscribe = (topics, callback) => callback(null, topics.map(topic => ({ topic, qos: 128 })));
  client.emit('connect');
  assert.match(writeSwitch(soundSwitch(env, platform), true)[0].message, /unavailable/);
  assert.equal(client.publications.length, 0);
  client.subscribe = subscribe;
  const retry = [...env.state.timers].find(([, timer]) => timer.delay === 5000);
  assert.ok(retry, 'A connected broker that denies SUBACK must be retried');
  env.runTimer(retry[0]);
  const responses = writeSwitch(soundSwitch(env, platform), true);
  music(client, 'play');
  assert.deepEqual(responses, [null]);
  env.api.emit('shutdown');
});

test('DHCP address and certificate updates replace MQTT without duplicating HomeKit accessories', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  const first = env.state.mqtt[0];
  first.emit('connect');
  const camera = [...platform.cameras.values()][0];
  const uuid = camera.accessory.UUID;
  const registered = env.state.registered.length;
  const characteristic = soundSwitch(env, platform);
  const pending = writeSwitch(characteristic, true);
  env.account.records[0] = { ...env.account.records[0], name: 'Renamed in app', ip: '192.0.2.41' };
  await platform.refreshAccount();
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.registered.length, registered);
  assert.equal(camera.accessory.UUID, uuid);
  assert.equal(camera.accessory.displayName, 'Nursery');
  assert.equal(first.endCalls, 1);
  assert.equal(pending.length, 1);
  assert.equal(env.state.mqtt[1].url, 'mqtts://192.0.2.41:1883');
  assert.ok(camera.config.source.includes('@192.0.2.41:554/'));
  first.emit('connect');
  music(first, 'play');
  assert.match(writeSwitch(characteristic, true)[0].message, /unavailable/);
  env.state.mqtt[1].emit('connect');
  env.account.credentials = { cert: Buffer.from('rotated-cert'), key: Buffer.from('rotated-key') };
  await platform.refreshAccount();
  assert.equal(env.state.mqtt.length, 3);
  assert.equal(env.state.mqtt[1].endCalls, 1);
  assert.equal(env.state.mqtt[2].options.cert, env.account.credentials.cert);
  env.api.emit('shutdown');
  assert.equal(env.account.closed, true);
  assert.equal(env.state.mqtt[2].endCalls, 1);
  assert.equal(env.state.timers.size, 0);
});

test('temporary cloud failures and missing local addresses retain cached camera and switch accessories', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  env.account.listError = Object.assign(new Error('private-cloud-response'), { code: 'NETWORK_ERROR' });
  await platform.refreshAccount();
  assert.equal(env.state.unregistered.length, 0);
  assert.equal(env.state.mqtt[0].endCalls, 0);
  env.account.listError = undefined;
  env.account.records[0].ip = undefined;
  await platform.refreshAccount();
  assert.equal(env.state.unregistered.length, 0);
  assert.equal(platform.cameras.size, 1);
  env.account.lastCameraSource = 'cache';
  env.account.records = [];
  await platform.refreshAccount();
  assert.equal(env.state.unregistered.length, 0);
  assert.doesNotMatch(JSON.stringify(env.state.logs), /private-cloud-response/);
  env.api.emit('shutdown');
});

test('successful account reconciliation removes deleted devices and clears their MQTT and switch timers', async () => {
  const env = environment();
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  const client = env.state.mqtt[0];
  client.emit('connect');
  const pending = writeSwitch(soundSwitch(env, platform), true);
  env.account.records = [];
  await platform.refreshAccount();
  assert.equal(env.state.unregistered.length, 2);
  assert.equal(platform.cameras.size, 0);
  assert.equal(client.endCalls, 1);
  assert.equal(pending.length, 1);
  assert.ok(pending[0]);
  env.api.emit('shutdown');
  assert.equal(client.endCalls, 1);
  assert.equal(env.state.timers.size, 0);
});

test('existing name-based HomeKit camera and switch survive migration to account setup', async () => {
  const env = environment();
  const config = { ...env.config, lollipops: [{ name: 'Crib', ip: '192.0.2.99', enableSoundMachine: true }] };
  const platform = env.createPlatform(config);
  const camera = new env.TestAccessory('Crib', env.generateUUID('Crib Camera'));
  camera.getService(env.Service.AccessoryInformation).setCharacteristic(env.Characteristic.SerialNumber, 'synthetic-camera');
  const sound = new env.TestAccessory('Crib Sound Machine', env.generateUUID('Crib Sound Machine'));
  sound.addService(env.Service.Switch, sound.displayName);
  platform.configureAccessory(camera);
  platform.configureAccessory(sound);
  await platform.didFinishLaunching();
  assert.equal(env.state.unregistered.length, 0);
  assert.equal(env.state.registered.length, 0);
  assert.equal([...platform.cameras.values()][0].accessory, camera);
  assert.equal(env.state.mqtt[0].url, 'mqtts://192.0.2.40:1883', 'Account discovery supersedes an old manually configured IP');
  assert.equal(soundSwitch(env, platform), sound.getService(env.Service.Switch).getCharacteristic(env.Characteristic.On));
  env.api.emit('shutdown');
});

test('missing MQTT credentials retain video and recover the switch on a later successful refresh', async () => {
  const env = environment();
  env.account.keyError = Object.assign(new Error('private-credential-url'), { code: 'SERVICE_UNAVAILABLE' });
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 0);
  const characteristic = soundSwitch(env, platform);
  assert.match(writeSwitch(characteristic, true)[0].message, /unavailable/);
  env.account.keyError = undefined;
  await platform.refreshAccount();
  assert.equal(env.state.controllers.length, 1);
  assert.equal(env.state.mqtt.length, 1);
  env.state.mqtt[0].emit('connect');
  const responses = writeSwitch(characteristic, true);
  music(env.state.mqtt[0], 'play');
  assert.deepEqual(responses, [null]);
  assert.doesNotMatch(JSON.stringify(env.state.logs), /private-credential-url/);
  env.api.emit('shutdown');
});

test('an OTP challenge preserves cached accessories and never loops account login', async () => {
  const env = environment();
  env.account.authError = Object.assign(new Error('private-auth-body'), { code: 'OTP_REQUIRED' });
  const platform = env.createPlatform(env.config);
  const camera = new env.TestAccessory('Saved camera');
  platform.configureAccessory(camera);
  await platform.didFinishLaunching();
  assert.equal(env.state.unregistered.length, 0);
  assert.equal(env.state.mqtt.length, 0);
  assert.equal(env.state.timers.size, 0);
  assert.ok(env.state.logs.some(item => JSON.stringify(item).includes('email-code')));
  assert.doesNotMatch(JSON.stringify(env.state.logs), /private-auth-body/);
  env.api.emit('shutdown');
});

test('shutdown during discovery does not publish an accessory or schedule more work', async () => {
  const env = environment();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  env.account.listCameras = () => new Promise(resolve => { release = resolve; entered(); });
  const platform = env.createPlatform(env.config);
  const launch = platform.didFinishLaunching();
  await started;
  env.api.emit('shutdown');
  release(env.account.records);
  await launch;
  assert.equal(env.state.registered.length, 0);
  assert.equal(env.state.mqtt.length, 0);
  assert.equal(env.state.timers.size, 0);
});

test('denied MQTT access for one camera does not prevent setup of another authorized camera', async () => {
  const env = environment();
  env.account.records.push({ cameraId: 'second-camera', name: 'Second room', ip: '192.0.2.42' });
  env.account.getMqttCredentials = async id => {
    if (id === 'synthetic-camera') throw Object.assign(new Error('private-access-response'), { code: 'ACCESS_DENIED' });
    return env.account.credentials;
  };
  const platform = env.createPlatform(env.config);
  await platform.didFinishLaunching();
  assert.equal(env.state.controllers.length, 2);
  assert.equal(env.state.mqtt.length, 1);
  assert.equal(env.state.mqtt[0].url, 'mqtts://192.0.2.42:1883');
  assert.equal(env.state.unregistered.length, 0);
  assert.ok(env.state.logs.some(item => JSON.stringify(item).includes('camera-owner access')));
  assert.doesNotMatch(JSON.stringify(env.state.logs), /private-access-response/);
  env.api.emit('shutdown');
});
