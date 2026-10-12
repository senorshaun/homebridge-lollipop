'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const test = require('node:test');
const packageJson = require('../package.json');

const root = path.resolve(__dirname, '..');
// Run the same integration against the minimum supported Homebridge release
// without replacing the normal, locked development dependency.
const homebridgeDist = process.env.LOLLIPOP_TEST_HOMEBRIDGE_PATH
    ? path.join(path.resolve(process.env.LOLLIPOP_TEST_HOMEBRIDGE_PATH), 'dist')
    : path.dirname(require.resolve('homebridge'));

async function loadHomebridge() {
    const [api, plugin, accessory] = await Promise.all([
        import(pathToFileURL(path.join(homebridgeDist, 'api.js')).href),
        import(pathToFileURL(path.join(homebridgeDist, 'plugin.js')).href),
        import(pathToFileURL(path.join(homebridgeDist, 'platformAccessory.js')).href)
    ]);
    return { ...api, ...plugin, ...accessory };
}

async function loadPlatform(t, config = {}) {
    const hb = await loadHomebridge();
    const api = new hb.HomebridgeAPI();
    const plugin = new hb.Plugin(packageJson.name, root, packageJson);
    const registrations = [];
    const logs = [];
    const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
        level, (...args) => logs.push({ level, args })
    ]));
    api.on('registerPlatform', (name, constructor, identifier) => {
        assert.equal(identifier, 'homebridge-lollipop');
        assert.equal(name, 'Lollipop');
        plugin.registerPlatform(name, constructor);
    });
    api.on('registerPlatformAccessories', accessories => registrations.push(...accessories));
    await plugin.load();
    await plugin.initialize(api);
    const Platform = plugin.getPlatformConstructor('Lollipop');
    const platform = new Platform(log, { platform: 'Lollipop', ...config }, api);
    t.after(() => api.emit('shutdown'));
    return { hb, api, plugin, Platform, platform, registrations, logs };
}

function denyCameraNetwork(t) {
    // These tests exercise the real Homebridge/HAP API but never a vendor
    // account or camera. Any accidental MQTT connection must fail the test.
    // MQTT.js 5 exposes connect as a read-only module getter. Guard the
    // actual client method instead, before it can create any socket.
    t.mock.method(require('mqtt').MqttClient.prototype, 'connect', () => {
        throw new Error('A real camera connection is not allowed in the Homebridge integration test.');
    });
}

test('Homebridge 2 loads the published CommonJS initializer and restores a real camera controller', async t => {
    denyCameraNetwork(t);
    const config = { lollipops: [{ name: 'Compatibility camera', cameraId: 'synthetic-camera', ip: '192.0.2.10', audio: true }] };
    const f = await loadPlatform(t, config);
    assert.match(f.api.serverVersion, /^2\./);
    f.api.emit('didFinishLaunching');
    assert.equal(f.registrations.length, 1);
    const camera = [...f.platform.cameras.values()][0];
    assert.ok(camera.streamingDelegate.controller instanceof f.api.hap.CameraController);
    assert.equal(camera.config.hksv, false);
    assert.equal(camera.accessory.category, f.api.hap.Categories.IP_CAMERA);
    const streamCount = accessory => accessory.services.filter(service => service.UUID === f.api.hap.Service.CameraRTPStreamManagement.UUID).length;
    assert.equal(streamCount(camera.accessory), 5);
    assert.ok(camera.accessory.getService(f.api.hap.Service.Microphone));
    assert.equal(camera.accessory.getService(f.api.hap.Service.CameraRecordingManagement), undefined);

    const saved = f.hb.PlatformAccessory.serialize(camera.accessory);
    f.api.emit('shutdown');
    const restored = f.hb.PlatformAccessory.deserialize(saved);
    const next = await loadPlatform(t, config);
    next.platform.configureAccessory(restored);
    next.api.emit('didFinishLaunching');
    assert.equal(next.registrations.length, 0, 'Restoring a camera must not register it again');
    assert.equal(next.platform.cameras.size, 1);
    assert.equal([...next.platform.cameras.values()][0].accessory, restored);
    assert.equal(restored.UUID, saved.UUID);
    assert.equal(streamCount(restored), 5, 'Restoration must reuse the existing camera services');
});

test('real HAP 2 sound reads and writes wait for camera status and account sensors accept events', async t => {
    denyCameraNetwork(t);
    const f = await loadPlatform(t);
    const { Service, Characteristic } = f.api.hap;
    const warnings = [];
    const config = {
        name: 'Account compatibility camera', cameraId: 'synthetic-account-camera',
        pairingID: 'synthetic-account-camera', ip: '192.0.2.11', audio: true,
        movementSensitivity: 10, enableCryingDetectionSensor: true,
        enableCrossingDetectionSensor: true, enableNoiseSensor: true,
        enableSoundMachine: true, contactSensors: true
    };
    const uuid = f.api.hap.uuid.generate('account-compatibility-camera');
    const accessory = new f.api.platformAccessory(config.name, uuid);
    accessory._associatedHAPAccessory.on('characteristic-warning', warning => warnings.push(warning));
    f.platform.accessories[uuid] = accessory;
    const camera = f.platform.addCamera(config, uuid, { credentials: undefined });
    assert.equal(camera.config.hksv, false);
    assert.equal(f.registrations.length, 1, 'Only the new sound switch needs registration');
    const soundAccessory = f.registrations[0];
    soundAccessory._associatedHAPAccessory.on('characteristic-warning', warning => warnings.push(warning));
    const on = soundAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On);
    const publications = [];
    const client = {
        connected: true,
        publish(topic, payload, options, callback) {
            publications.push({ topic, body: JSON.parse(payload), options });
            if (callback) callback();
        }
    };
    camera.soundMachine.setClient(client);
    camera.soundMachine.setConnected(true);
    camera.musicStatusHandler(null, { result: { playStatus: 'pause', countdownTimer: 600 } });
    assert.equal(await on.handleGetRequest(), false);

    let confirmed = false;
    const turningOn = on.handleSetRequest(true).then(() => { confirmed = true; });
    await Promise.resolve();
    const command = publications.find(publication => publication.body.method === 'controlMusic');
    assert.equal(command.body.params.playStatus, 'play');
    assert.equal(command.body.params.repeatStatus, 'one');
    assert.equal(command.options.retain, false);
    camera.soundMachine.controlResult({ status: 1 });
    await Promise.resolve();
    assert.equal(confirmed, false, 'A publish or control acknowledgment is not playback confirmation');
    camera.musicStatusHandler(null, { result: { playStatus: 'play' } });
    await turningOn;
    assert.equal(await on.handleGetRequest(), true);

    const turningOff = on.handleSetRequest(false);
    await Promise.resolve();
    camera.musicStatusHandler(null, { result: { playStatus: 'pause' } });
    await turningOff;
    assert.equal(await on.handleGetRequest(), false);

    for (const sensor of Object.values(camera.sensors).filter(sensor => sensor.name !== 'HKSV Sensor')) {
        const service = accessory.getServiceById(Service.ContactSensor, sensor.name);
        assert.ok(service);
        camera.sensorHandler(true, sensor);
        assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, 1);
        camera.sensorHandler(false, sensor);
        assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, 0);
    }
    camera.soundMachine.setConnected(false);
    await assert.rejects(on.handleGetRequest());
    await assert.rejects(on.handleSetRequest(true));
    assert.equal(warnings.length, 0, 'Current HAP must not report invalid service or characteristic values');
});

test('real Homebridge camera snapshot callback completes through the plugin delegate', async t => {
    denyCameraNetwork(t);
    const spawns = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    t.mock.method(childProcess, 'spawn', (binary, args) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        spawns.push({ binary, args });
        queueMicrotask(() => {
            child.stdout.end(jpeg);
            child.stderr.end();
            child.emit('close', 0, null);
        });
        return child;
    });
    const f = await loadPlatform(t, { lollipops: [{ name: 'Snapshot compatibility camera', cameraId: 'synthetic-snapshot-camera', ip: '192.0.2.12' }] });
    f.api.emit('didFinishLaunching');
    const camera = [...f.platform.cameras.values()][0];
    const image = await camera.streamingDelegate.controller.handleSnapshotRequest(180, 320, camera.accessory.displayName);
    assert.deepEqual(image, jpeg);
    assert.equal(spawns.length, 2, 'Snapshot source fetch and resize both pass through the delegate');
    assert.ok(spawns[0].args.includes('-rtsp_transport'));
    assert.ok(spawns[1].args.includes('pipe:'));
});
