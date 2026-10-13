'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

// Run the actual platform entry point. Only its account/camera dependencies and
// Homebridge boundary are fixtures; these tests need no npm packages or network.
function fixture(config = { account: { email: 'owner@example.test' } }) {
    const state = {
        timers: new Map(), logs: [], diagnostics: [], created: [], registered: [],
        unregistered: [], updated: [], published: [], accountCalls: [],
    };
    let nextTimer = 0;
    const setTimer = (callback, delay) => {
        const timer = { id: ++nextTimer, unref() {} };
        state.timers.set(timer, { callback, delay });
        return timer;
    };
    const account = {
        lastCameraSource: 'cloud', closeCalls: 0,
        records: [{ cameraId: 'synthetic-id', name: 'Nursery', ip: '192.0.2.10' }],
        async authenticate() { state.accountCalls.push('authenticate'); },
        async listCameras() { state.accountCalls.push('list'); return this.records; },
        async getMqttCredentials() { state.accountCalls.push('credentials'); return {}; },
        close() { this.closeCalls++; },
    };
    class Logger {
        constructor(_, debug) { this.debugMode = debug === true; }
        debug() {}
        info(message) { state.logs.push({ level: 'info', message }); }
        warn(message) { state.logs.push({ level: 'warn', message }); }
        error(message) { state.logs.push({ level: 'error', message }); }
        addSecrets() {}
    }
    class Accessory {
        constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; }
        getService() { return undefined; }
    }
    class Camera {
        constructor(log, settings, accessory, api) {
            this.config = settings;
            this.accessory = accessory;
            this.shutdownCalls = 0;
            state.created.push(this);
            // The real camera already has a fallback handler and an idempotent
            // shutdown. Exercise that event ordering, not just a direct call.
            api.on('shutdown', () => this.shutdown());
        }
        shutdown() {
            if (this.stopped) return;
            this.stopped = true;
            this.shutdownCalls++;
            if (this.failShutdown) throw new Error('private-camera-details');
        }
        updateAccountConnection() { state.accountCalls.push('update'); }
    }
    const api = new EventEmitter();
    api.serverVersion = '2.4.0';
    api.user = { storagePath: () => '/synthetic-homebridge' };
    api.hap = {
        uuid: { generate: name => 'uuid:' + name },
        Service: { AccessoryInformation: 'information', Switch: 'switch' },
        Characteristic: { SerialNumber: 'serial' },
    };
    api.platformAccessory = Accessory;
    for (const [method, output] of [
        ['registerPlatformAccessories', 'registered'],
        ['unregisterPlatformAccessories', 'unregistered'],
        ['publishExternalAccessories', 'published'],
        ['updatePlatformAccessories', 'updated'],
    ]) api[method] = (...args) => state[output].push(args);

    const dependencies = {
        path,
        './lib/logger': { Logger },
        './lib/diagnostics': { emitDiagnostic: (_, event, fields) => state.diagnostics.push({ event, ...fields }) },
        './lib/lollipop': Camera,
        './lib/lollipopAccount': { LollipopAccount: class { constructor() { return account; } } },
        './lib/cameraConnection': { resolveCameraConnection() {}, hasDirectStreamConfig() { return false; } },
        './lib/mqttAuth': { createAuthenticatedMqttOptions() { return {}; } },
        './package.json': { version: '0.0.1-test' },
        'mqtt/package.json': { version: '5.16.0' },
    };
    const module = { exports: {} };
    const filename = path.join(__dirname, '../index.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, process, setTimeout: setTimer,
        clearTimeout: timer => state.timers.delete(timer),
        require(name) {
            assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name);
            return dependencies[name];
        },
    }, { filename });
    let Platform;
    module.exports({ registerPlatform(_, __, constructor) { Platform = constructor; } });
    const platform = new Platform({}, config, api);
    return { platform, api, account, state, setTimer, config };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const errors = f => f.state.logs.filter(entry => entry.level === 'error');

function assertNoNewWork(f) {
    assert.equal(f.state.created.length, 0);
    assert.equal(f.state.registered.length, 0);
    assert.equal(f.state.published.length, 0);
    assert.equal(f.state.unregistered.length, 0);
    assert.equal(f.state.timers.size, 0);
    assert.equal(f.platform.refreshing, false);
}

test('platform shutdown explicitly closes every camera, refresh timer and account once', () => {
    const f = fixture();
    f.platform.account = f.account;
    const first = f.platform.addCamera({ name: 'Nursery' }, 'one');
    const second = f.platform.addCamera({ name: 'Bedroom' }, 'two');
    f.platform.refreshTimer = f.setTimer(() => assert.fail('Refresh ran during shutdown'), 300000);
    const savedConfig = JSON.stringify(f.config);
    const savedAccessories = { ...f.platform.accessories };
    const registrations = f.state.registered.length;
    f.platform.shutdown();
    assert.equal(f.platform.stopped, true);
    assert.equal(first.shutdownCalls, 1);
    assert.equal(second.shutdownCalls, 1);
    assert.equal(f.account.closeCalls, 1);
    assert.equal(f.platform.cameras.size, 0);
    assert.equal(f.platform.refreshTimer, undefined);
    assert.equal(f.state.timers.size, 0);
    assert.equal(f.state.unregistered.length, 0);
    assert.equal(f.state.registered.length, registrations);
    assert.equal(JSON.stringify(f.config), savedConfig);
    assert.deepEqual({ ...f.platform.accessories }, savedAccessories, 'Retain pairing/cache state');
    f.api.emit('shutdown');
    f.api.emit('shutdown');
    assert.equal(first.shutdownCalls, 1);
    assert.equal(second.shutdownCalls, 1);
    assert.equal(f.account.closeCalls, 1);
    assert.deepEqual(f.state.diagnostics.filter(item => item.event === 'platform.shutdown').map(item => item.phase),
        ['start', 'complete']);
});

test('a failing camera does not prevent other cameras, the account, or later shutdown listeners from closing', () => {
    const f = fixture();
    f.platform.account = f.account;
    const first = f.platform.addCamera({ name: 'First' }, 'one');
    const second = f.platform.addCamera({ name: 'Second' }, 'two');
    first.failShutdown = true;
    let laterHandlerRan = false;
    f.api.on('shutdown', () => { laterHandlerRan = true; });
    assert.doesNotThrow(() => f.api.emit('shutdown'));
    assert.equal(first.shutdownCalls, 1);
    assert.equal(second.shutdownCalls, 1);
    assert.equal(f.account.closeCalls, 1);
    assert.equal(laterHandlerRan, true);
    assert.equal(errors(f).length, 1);
    assert.doesNotMatch(JSON.stringify(f.state.logs), /private-camera-details/);
    assert.equal(f.state.diagnostics.filter(item => item.event === 'platform.shutdown').at(-1).phase, 'failed');
});

test('account-close failure is safe and does not interrupt camera or later API shutdown handlers', () => {
    const f = fixture();
    const camera = f.platform.addCamera({ name: 'Nursery' }, 'one');
    f.platform.account = f.account;
    f.account.close = () => { f.account.closeCalls++; throw new Error('private-account-token'); };
    let ran = false;
    f.api.on('shutdown', () => { ran = true; });
    assert.doesNotThrow(() => f.api.emit('shutdown'));
    assert.equal(camera.shutdownCalls, 1);
    assert.equal(ran, true);
    assert.equal(f.account.closeCalls, 1);
    assert.doesNotThrow(() => f.api.emit('shutdown'));
    assert.equal(f.account.closeCalls, 1);
    assert.equal(errors(f).length, 1);
    assert.doesNotMatch(JSON.stringify(f.state.logs), /private-account-token/);
});

test('shutdown before configuration/launch never starts account or camera work', async () => {
    const f = fixture({});
    f.api.emit('shutdown');
    f.api.emit('didFinishLaunching');
    await f.platform.refreshAccount();
    f.platform.refreshRejectedCredentials('ignored');
    assert.equal(f.platform.addCamera({ name: 'Late' }, 'late'), undefined);
    assert.equal(f.state.accountCalls.length, 0);
    assert.equal(f.state.created.length, 0);
    assert.equal(f.state.timers.size, 0);
    assert.equal(f.account.closeCalls, 0);
});

test('manual camera setup uses the same shutdown coordination without creating an account', () => {
    const f = fixture({ lollipops: [{ name: 'Manual', ip: '192.0.2.10' }] });
    f.api.emit('didFinishLaunching');
    assert.equal(f.state.created.length, 1);
    f.api.emit('shutdown');
    assert.equal(f.state.created[0].shutdownCalls, 1);
    assert.equal(f.account.closeCalls, 0);
    assert.equal(f.state.unregistered.length, 0);
});

test('shutdown during authentication prevents a subsequent camera-list request', async () => {
    const f = fixture();
    const pending = deferred();
    f.account.authenticate = () => pending.promise;
    const refresh = f.platform.refreshAccount();
    f.api.emit('shutdown');
    pending.resolve();
    await refresh;
    assert.deepEqual(f.state.accountCalls, []);
    assert.equal(f.account.closeCalls, 1);
    assertNoNewWork(f);
});

test('an account request aborted by shutdown does not produce a misleading sign-in/retry error', async () => {
    const f = fixture();
    const pending = deferred();
    f.account.authenticate = () => pending.promise;
    const refresh = f.platform.refreshAccount();
    f.api.emit('shutdown');
    pending.reject(Object.assign(new Error('private-session'), { code: 'INVALID_SESSION' }));
    await refresh;
    assert.equal(errors(f).length, 0);
    assert.equal(f.state.diagnostics.some(item => item.event === 'platform.refresh' && item.phase === 'failed'), false);
    assertNoNewWork(f);
});

test('late camera discovery cannot publish or remove accessories after shutdown', async () => {
    const f = fixture();
    const pending = deferred();
    f.account.listCameras = () => pending.promise;
    const refresh = f.platform.refreshAccount();
    await settle();
    f.api.emit('shutdown');
    pending.resolve(f.account.records);
    await refresh;
    assertNoNewWork(f);
    assert.equal(f.state.accountCalls.includes('credentials'), false);
});

test('credentials returned after shutdown cannot create cameras or schedule refreshes', async () => {
    const f = fixture();
    const pending = deferred();
    f.account.getMqttCredentials = () => pending.promise;
    const refresh = f.platform.refreshAccount();
    await settle();
    f.api.emit('shutdown');
    pending.resolve({});
    await refresh;
    assertNoNewWork(f);
    assert.equal(errors(f).length, 0);
});

test('credential cancellation during shutdown does not warn that MQTT will retry', async () => {
    const f = fixture();
    const pending = deferred();
    f.account.getMqttCredentials = () => pending.promise;
    const refresh = f.platform.refreshAccount();
    await settle();
    f.api.emit('shutdown');
    pending.reject(Object.assign(new Error('private-key-url'), { code: 'CLOSED' }));
    await refresh;
    assertNoNewWork(f);
    assert.equal(f.state.logs.filter(entry => ['warn', 'error'].includes(entry.level)).length, 0);
});

test('ordinary cloud failures still report errors and schedule a retry until shutdown', async () => {
    const f = fixture();
    f.account.authenticate = async () => { throw Object.assign(new Error('private-network-body'), { code: 'NETWORK_ERROR' }); };
    await f.platform.refreshAccount();
    assert.equal(errors(f).length, 1);
    assert.equal(f.state.timers.size, 1);
    assert.equal([...f.state.timers.values()][0].delay, 300000);
    assert.doesNotMatch(JSON.stringify(f.state.logs), /private-network-body/);
    f.api.emit('shutdown');
    assert.equal(f.state.timers.size, 0);
});
