'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const configApi = require('../homebridge-ui/public/config');
const { configureAccount, configureDebug } = configApi;
const copy = value => JSON.parse(JSON.stringify(value));
const email = 'owner@example.com';
const childBridge = { username: 'AA:BB:CC:DD:EE:FF', port: 51842, name: 'Camera child bridge' };
const alias = 'Lollipop';

function single(configs) {
  const matches = configs.filter(config => config.platform === alias);
  assert.equal(matches.length, 1, 'The singular plugin must contain exactly one canonical platform');
  return matches[0];
}

test('account sign-in reuses a schema draft with no platform discriminator', () => {
  const original = [{ name: alias, debug: true, _bridge: childBridge, lollipops: [{}] }];
  const saved = configureAccount(original, ' Owner@Example.com ');
  assert.equal(saved.length, 1);
  assert.deepEqual(single(saved)._bridge, childBridge);
  assert.deepEqual(saved[0].account, { email });
  assert.equal(saved[0].debug, true);
  assert.equal(saved[0].lollipops, undefined);
  assert.equal(original[0].platform, undefined, 'Caller-owned state is not mutated');
});

test('debug enabled before sign-in does not create an orphan child-bridge block', () => {
  for (const platform of [undefined, '', null, 'homebridge-lollipop.Lollipop', alias]) {
    const original = [{ platform, _bridge: childBridge, name: alias }];
    const saved = configureAccount(configureDebug(original, true), email);
    assert.equal(saved.length, 1);
    assert.deepEqual(single(saved)._bridge, childBridge);
    assert.equal(saved[0].debug, true);
    assert.deepEqual(saved[0].account, { email });
  }
});

test('the tester split-block shape is consolidated while preserving explicit false/zero values', () => {
  const original = [
    { platform: alias, debug: true, _bridge: childBridge, cameraDefaults: { audio: false, movementSensitivity: 0 },
      lollipops: [{ name: '', rtspUsername: 'homebridge', enabled: true, audio: true,
        enableSoundMachine: true, movementSensitivity: 10, hksv: false }] },
    { platform: alias, account: { email }, cameraDefaults: { audio: true, enableSoundMachine: true, unbridge: false } },
  ];
  const snapshot = copy(original);
  const result = configureDebug(original, true);
  assert.equal(result.length, 1);
  assert.deepEqual(single(result), {
    platform: alias, _bridge: childBridge, debug: true, account: { email },
    cameraDefaults: { audio: false, movementSensitivity: 0, enableSoundMachine: true, unbridge: false },
  });
  assert.deepEqual(original, snapshot);
});

test('the child-bridge block can be second without losing its identity', () => {
  const result = configureAccount([
    { platform: alias, account: { email } },
    { platform: alias, _bridge: childBridge, debug: true },
  ], email);
  assert.equal(result.length, 1);
  assert.deepEqual(single(result)._bridge, childBridge);
  assert.equal(result[0].debug, true);
});

test('non-Lollipop platforms/accessories remain unchanged in their relative order', () => {
  const other = { platform: 'OtherPlatform', privateSetting: 'unchanged' };
  const accessory = { accessory: 'OtherAccessory', name: 'Not a Lollipop draft' };
  const result = configureAccount([other, { _bridge: childBridge }, accessory, { platform: alias }], email);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], other);
  assert.deepEqual(result[2], accessory);
  assert.deepEqual(single(result)._bridge, childBridge);
});

test('real and partially completed camera overrides survive consolidation; identical rows are not duplicated', () => {
  const camera1 = { name: 'Nursery', accountCameraName: 'Original name', enabled: false };
  const camera2 = { name: 'Bedroom', ip: '192.0.2.10', cameraId: 'synthetic-camera-id' };
  const partial = { ip: '192.0.2.11' };
  const edited = { movementSensitivity: 2 };
  const result = configureAccount([
    { platform: alias, lollipops: [camera1, {}] },
    { platform: alias, lollipops: [camera1, camera2, partial, edited] },
  ], email);
  assert.deepEqual(single(result).lollipops, [camera1, camera2, partial, edited]);
});

test('repeated account/debug saves are idempotent and cannot recreate duplicate platforms', () => {
  let configs = [{ _bridge: childBridge }, { platform: alias, account: { email } }];
  configs = configureAccount(configureDebug(configs, true), email);
  const expected = copy(configs);
  for (let i = 0; i < 20; i++) configs = configureAccount(configureDebug(configs, true), email);
  assert.deepEqual(configs, expected);
});

test('interactive sign-in clears old headless credentials from every merged Lollipop block only', () => {
  const other = { platform: 'OtherPlugin', account: { password: 'belongs-to-other-plugin' } };
  const result = configureAccount([
    other,
    { platform: alias, account: { email, password: 'old-password' } },
    { platform: alias, account: { email: 'old-account@example.com', sessionToken: 'old-token' } },
  ], email);
  assert.deepEqual(result[0], other);
  assert.deepEqual(single(result).account, { email });
  assert.doesNotMatch(JSON.stringify(result), /old-password|old-token|old-account/);
});

test('debug alone preserves valid headless credentials rather than signing out the account', () => {
  const account = { email, password: 'synthetic-password', sessionToken: 'synthetic-session' };
  const result = configureDebug([{ platform: alias, account, _bridge: childBridge }], false);
  assert.deepEqual(single(result).account, account);
  assert.deepEqual(result[0]._bridge, childBridge);
});

test('different child bridges fail before mutation rather than silently discarding pairing data', () => {
  for (const change of [{ username: '11:22:33:44:55:66' }, { port: 51843 }]) {
    const configs = [{ platform: alias, _bridge: childBridge },
      { platform: alias, _bridge: { ...childBridge, ...change } }];
    const before = copy(configs);
    assert.throws(() => configureAccount(configs, email), error => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.doesNotMatch(error.message, /AA:BB|11:22|owner@example/);
      return true;
    });
    assert.deepEqual(configs, before);
  }
});

test('matching and complementary child-bridge settings merge without assigning a new identity', () => {
  const result = configureAccount([
    { platform: alias, _bridge: { username: childBridge.username } },
    { platform: alias, _bridge: childBridge },
  ], email);
  assert.deepEqual(single(result)._bridge, childBridge);
});

test('debug save refuses different accounts; an explicit new sign-in may replace the account', () => {
  const configs = [{ platform: alias, account: { email } },
    { platform: alias, account: { email: 'other@example.com' } }];
  assert.throws(() => configureDebug(configs, true), { code: 'CONFIG_CONFLICT' });
  assert.deepEqual(single(configureAccount(configs, email)).account, { email });
});

test('malformed config and conflicting session credentials fail safely', () => {
  for (const configs of [{}, [null], [42], [{ platform: alias, _bridge: false }],
    [{ platform: alias, lollipops: 'not-an-array' }],
    [{ platform: alias, account: { email, sessionToken: 'one' } },
      { platform: alias, account: { email, sessionToken: 'two' } }]]) {
    assert.throws(() => configureDebug(configs, true), { code: 'CONFIG_CONFLICT' });
  }
});

test('fresh configuration and strict debug semantics remain compatible', () => {
  assert.deepEqual(configureDebug([], true), [{ platform: alias, name: alias, debug: true }]);
  for (const enabled of [false, undefined, null, 0, 1, 'true', {}, []]) {
    assert.equal(single(configureDebug([], enabled)).debug, false);
  }
  assert.deepEqual(single(configureAccount([], email)).cameraDefaults, { audio: true, enableSoundMachine: true });
});

function browser(initialConfig = [], options = {}) {
  class Element {
    constructor() { this.hidden = false; this.value = ''; this.checked = false; this.textContent = ''; this.handlers = {}; this.children = []; }
    addEventListener(event, handler) { this.handlers[event] = handler; }
    dispatch(event) { return this.handlers[event]({ preventDefault() {} }); }
    focus() {}
    replaceChildren() { this.children = []; }
    appendChild(child) { this.children.push(child); }
    set innerHTML(_) { throw new Error('Unsafe rendering'); }
  }
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const state = { configs: copy(initialConfig), disk: copy(initialConfig), requests: [], updates: [], saves: 0,
    listeners: {}, failSave: false, shown: 0 };
  const bridge = {
    async getPluginConfig() { return copy(state.configs); },
    async updatePluginConfig(configs) {
      state.configs = copy(configs);
      state.updates.push(copy(configs));
      state.listeners.configChanged?.({ data: copy(configs) });
    },
    async savePluginConfig() {
      if (state.failSave) throw new Error('Synthetic save failure');
      assert.ok(state.configs.every(config => config.platform || config.accessory), 'Homebridge requires platform/accessory');
      single(state.configs);
      state.disk = copy(state.configs);
      state.saves++;
    },
    async request(route, body) {
      state.requests.push({ route, body });
      if (options.otp && route === '/account/login') return { requiresOtp: true };
      if (route === '/account/otp' && body.code !== '123456') throw { error: { code: 'INVALID_OTP' } };
      return { authenticated: true, cameraCount: 2, cameras: [{ name: 'Nursery' }, { name: 'Bedroom' }] };
    },
    addEventListener(name, handler) { state.listeners[name] = handler; },
    showSchemaForm() { state.shown++; },
  };
  const context = vm.createContext({ window: { homebridge: bridge, LollipopSetupConfig: configApi },
    document: { getElementById: byId, querySelectorAll: () => [], createElement: () => new Element() } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/setup.js'), 'utf8'), context);
  return { state, byId, bridge };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function login(ui) {
  ui.byId('account-email').value = email;
  ui.byId('account-password').value = 'private-test-password';
  ui.byId('login-form').dispatch('submit');
  await settle();
}

test('real setup script: child-bridge draft -> debug -> OTP -> save -> reopen stays one platform', async () => {
  const ui = browser([{ name: alias, _bridge: childBridge, lollipops: [{}] }], { otp: true });
  await settle();
  ui.byId('debug-logging').checked = true;
  ui.byId('debug-logging').dispatch('change');
  await settle();
  assert.equal(ui.state.saves, 1);
  assert.deepEqual(single(ui.state.disk)._bridge, childBridge);
  await login(ui);
  assert.equal(ui.byId('account-password').value, '');
  assert.equal(ui.byId('otp-form').hidden, false);
  // The native editor can assign more child-bridge options while OTP is pending.
  ui.state.configs[0]._bridge = { ...childBridge, pin: '031-45-154' };
  ui.byId('account-code').value = '000000';
  ui.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(ui.state.saves, 1);
  ui.byId('account-code').value = '123456';
  ui.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(ui.state.saves, 2);
  assert.deepEqual(single(ui.state.disk).account, { email });
  assert.equal(ui.state.disk[0]._bridge.pin, '031-45-154');
  assert.equal(ui.state.disk[0].lollipops, undefined);
  assert.doesNotMatch(JSON.stringify(ui.state.disk), /private-test-password|123456|000000/);
  const reopened = browser(ui.state.disk);
  await settle();
  assert.equal(reopened.state.requests[0].route, '/account/status');
  assert.equal(reopened.state.requests[0].body.email, email);
  assert.equal(reopened.state.saves, 0, 'Reopening does not silently rewrite disk');
});

test('real setup script: existing split config is repaired on debug save without cloud login', async () => {
  const ui = browser([{ platform: alias, _bridge: childBridge, lollipops: [{}] },
    { platform: alias, account: { email }, cameraDefaults: { unbridge: false } }]);
  await settle();
  ui.byId('debug-logging').checked = true;
  ui.byId('debug-logging').dispatch('change');
  await settle();
  assert.equal(ui.state.requests.length, 0);
  assert.equal(ui.state.saves, 1);
  assert.deepEqual(single(ui.state.disk)._bridge, childBridge);
  assert.deepEqual(ui.state.disk[0].account, { email });
});

test('real setup script: direct sign-in and save retry keep the existing bridge and native edits', async () => {
  const ui = browser([{ platform: 'homebridge-lollipop.Lollipop', _bridge: childBridge }]);
  await settle();
  ui.state.failSave = true;
  await login(ui);
  assert.equal(ui.state.saves, 0);
  assert.equal(ui.byId('save-account').hidden, false);
  ui.state.configs[0].cameraDefaults.audio = false;
  ui.state.failSave = false;
  ui.byId('save-account').dispatch('click');
  await settle();
  assert.equal(ui.state.requests.length, 1, 'Retry must not resend credentials');
  assert.equal(single(ui.state.disk).cameraDefaults.audio, false);
  assert.deepEqual(ui.state.disk[0]._bridge, childBridge);
  ui.byId('advanced-settings').dispatch('click');
  ui.byId('advanced-settings').dispatch('click');
  assert.equal(ui.state.shown, 1);
  // Emulate a native schema edit and its subsequent normal Save.
  ui.state.configs[0].cameraDefaults.enableSoundMachine = false;
  ui.state.listeners.configChanged({ data: copy(ui.state.configs) });
  await ui.bridge.savePluginConfig();
  assert.equal(single(ui.state.disk).cameraDefaults.enableSoundMachine, false);
  assert.deepEqual(ui.state.disk[0].account, { email });
});

test('real setup script explains conflicting bridges and never sends an unsafe update', async () => {
  const original = [{ platform: alias, _bridge: childBridge },
    { platform: alias, _bridge: { username: '11:22:33:44:55:66' } }];
  const ui = browser(original);
  await settle();
  await login(ui);
  assert.equal(ui.state.updates.length, 0);
  assert.equal(ui.state.saves, 0);
  assert.deepEqual(ui.state.disk, original);
  assert.match(ui.byId('setup-message').textContent, /conflicting account or child-bridge/);
  assert.doesNotMatch(ui.byId('setup-message').textContent, /AA:BB|11:22|owner@example/);
});
