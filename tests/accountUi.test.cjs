'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { AccountController } = require('../homebridge-ui/accountController');
const { configureAccount } = require('../homebridge-ui/public/config');

const email = 'owner@example.com';
const secret = 'synthetic-password-not-for-logs';
const storagePath = '/synthetic/homebridge/lollipop';

function createController(overrides = {}) {
  const state = { options: [], passwords: [], codes: [] };
  class Account {
    constructor(options) { state.options.push(options); }
    async signIn(password) {
      state.passwords.push(password);
      return { authenticated: true };
    }
    async authenticate() { return { authenticated: true }; }
    async verifyOtp(code) {
      state.codes.push(code);
      return { authenticated: true };
    }
    async listCameras() {
      return [{ name: 'Nursery', cameraId: 'private-id', ip: '192.0.2.1', rtspUrl: 'rtsp://private:password@camera/live' }];
    }
  }
  Object.assign(Account.prototype, overrides);
  return { state, controller: new AccountController({ storagePath, Account }) };
}

test('account UI login exchanges a password without returning cloud or camera credentials', async () => {
  const { state, controller } = createController();
  const result = await controller.handle('/account/login', { email: ' Owner@Example.com ', password: secret });
  assert.deepEqual(state.options, [{ storagePath, email }]);
  assert.deepEqual(state.passwords, [secret]);
  assert.deepEqual(result, {
    authenticated: true, cached: false, cameraCount: 1, cameras: [{ name: 'Nursery' }],
  });
  assert.doesNotMatch(JSON.stringify(result), /private-id|rtsp:|password|192\.0\.2/);
});

test('account UI rejects malformed credentials before calling the account service', async () => {
  const { controller, state } = createController();
  for (const body of [
    undefined, null, [], {}, { email: [] }, { email: 'not-an-email', password: secret },
    { email, password: null }, { email, password: [] }, { email, password: '' },
    { email, password: 'a'.repeat(4097) }, { email: 'a'.repeat(255) + '@example.com', password: secret },
    { email: 'owner\u0000@example.com', password: secret },
  ]) {
    await assert.rejects(controller.handle('/account/login', body), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(state.options.length, 0);
});

test('OTP verification belongs to the original login and permits correction of a rejected code', async () => {
  const { controller, state } = createController({
    async signIn() { return { requiresOtp: true, token: 'must-not-be-returned' }; },
    async verifyOtp(code) {
      state.codes.push(code);
      if (code !== '123456') throw Object.assign(new Error('sensitive vendor response'), { code: 'INVALID_CREDENTIALS' });
      return { authenticated: true, sessionToken: 'must-not-be-returned' };
    },
  });
  await assert.rejects(controller.handle('/account/otp', { email, code: '123456' }), error => error.code === 'OTP_NOT_STARTED');
  assert.deepEqual(await controller.handle('/account/login', { email, password: secret }), { requiresOtp: true });
  await assert.rejects(controller.handle('/account/otp', { email: 'someoneelse@example.com', code: '123456' }), error => error.code === 'OTP_NOT_STARTED');
  await assert.rejects(controller.handle('/account/otp', { email, code: 123456 }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(controller.handle('/account/otp', { email, code: '000000' }), error => error.code === 'INVALID_OTP' && !error.message.includes('sensitive'));
  const result = await controller.handle('/account/otp', { email, code: '123456' });
  assert.equal(result.authenticated, true);
  assert.deepEqual(state.codes, ['000000', '123456']);
  assert.equal(state.options.length, 1);
  await assert.rejects(controller.handle('/account/otp', { email, code: '123456' }), error => error.code === 'OTP_NOT_STARTED');
});

test('account UI sanitizes unknown and known error messages without retaining raw server data', async () => {
  for (const code of ['NETWORK_ERROR', 'new-server-error', '__proto__']) {
    const { controller } = createController({
      async signIn() { throw Object.assign(new Error(secret + ' https://private-key.example/secret'), { code, response: { secret } }); },
    });
    await assert.rejects(controller.handle('/account/login', { email, password: secret }), error => {
      assert.doesNotMatch(String(error.stack), /synthetic-password|private-key|https:/);
      assert.equal(error.response, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(error.code, code === 'NETWORK_ERROR' ? code : 'ACCOUNT_ERROR');
      return true;
    });
  }
});

test('a temporary camera-list failure keeps a successful sign-in available to save', async () => {
  const { controller } = createController({
    async listCameras() { throw Object.assign(new Error(secret), { code: 'NETWORK_ERROR' }); },
  });
  assert.deepEqual(await controller.handle('/account/login', { email, password: secret }), {
    authenticated: true, cached: false, discoveryPending: true, discoveryError: 'NETWORK_ERROR',
  });
});

test('account status validates the stored session without requiring the password again', async () => {
  const { controller, state } = createController({ async authenticate() { return { authenticated: true, cached: true }; } });
  const result = await controller.handle('/account/status', { email });
  assert.equal(result.authenticated, true);
  assert.equal(result.cached, true);
  assert.deepEqual(state.options, [{ storagePath, email }]);
  assert.deepEqual(state.passwords, []);
});

test('invalid sessions from discovery are not reported as a successful login', async () => {
  const { controller } = createController({
    async listCameras() { throw Object.assign(new Error(secret), { code: 'INVALID_SESSION' }); },
  });
  await assert.rejects(controller.handle('/account/status', { email }), error => error.code === 'INVALID_SESSION');
});

test('concurrent requests cannot replace an in-progress login or OTP challenge', async () => {
  let release;
  const { controller } = createController({ async signIn() { return new Promise(resolve => { release = resolve; }); } });
  const login = controller.handle('/account/login', { email, password: secret });
  await assert.rejects(controller.handle('/account/login', { email: 'other@example.com', password: secret }), error => error.code === 'REQUEST_IN_PROGRESS');
  await assert.rejects(controller.handle('/account/cancel', {}), error => error.code === 'REQUEST_IN_PROGRESS');
  release({ requiresOtp: true });
  assert.deepEqual(await login, { requiresOtp: true });
  assert.deepEqual(await controller.handle('/account/cancel', {}), { cancelled: true });
  await assert.rejects(controller.handle('/account/otp', { email, code: '123456' }), error => error.code === 'OTP_NOT_STARTED');
});

test('successful setup saves only the account email while preserving camera names and preferences', () => {
  const original = [{
    platform: 'Lollipop', name: 'My cameras', debug: true,
    account: { email: 'old@example.com', password: secret, sessionToken: 'private-session' },
    cameraDefaults: { audio: false, enableSoundMachine: false, unbridge: true },
    lollipops: [{ name: 'Original HomeKit name', accountCameraName: 'Nursery', enabled: true }],
  }];
  const snapshot = JSON.stringify(original);
  const saved = configureAccount(original, ' Owner@Example.com ');
  assert.deepEqual(saved[0].account, { email });
  assert.deepEqual(saved[0].lollipops, original[0].lollipops);
  assert.deepEqual(saved[0].cameraDefaults, original[0].cameraDefaults);
  assert.equal(saved[0].debug, true);
  assert.equal(saved[0].name, 'My cameras');
  assert.equal(JSON.stringify(original), snapshot, 'Editing setup must not mutate the source form state');
  assert.doesNotMatch(JSON.stringify(saved), /private-session|synthetic-password/);

  const fresh = configureAccount([], email);
  assert.equal(fresh[0].platform, 'Lollipop');
  assert.deepEqual(fresh[0].cameraDefaults, { audio: true, enableSoundMachine: true });
  assert.deepEqual(fresh[0].account, { email });
  assert.equal(fresh[0].lollipops, undefined, 'Automatic setup must not require camera IDs or IPs');
});

function createBrowser({ request, initialConfig = [], saveError = false } = {}) {
  class Element {
    constructor() { this.hidden = false; this.value = ''; this.textContent = ''; this.handlers = {}; this.children = []; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    dispatch(name) { return this.handlers[name]({ preventDefault() {} }); }
    focus() { this.focused = true; }
    replaceChildren() { this.children = []; }
    appendChild(child) { this.children.push(child); }
    set innerHTML(value) { throw new Error('Setup must render text, not HTML from account data'); }
  }
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  for (const id of ['setup-message', 'account-connected', 'otp-form', 'save-account']) byId(id).hidden = true;
  const state = { configs: initialConfig, requests: [], updates: [], saves: 0, showSchema: 0, saveError, listeners: {} };
  const homebridge = {
    async getPluginConfig() { return state.configs; },
    async updatePluginConfig(configs) { state.configs = configs; state.updates.push(configs); },
    async savePluginConfig() {
      if (state.saveError) throw new Error(secret);
      state.saves++;
    },
    async request(route, body) {
      state.requests.push({ route, body });
      return request ? request(route, body) : { authenticated: true, cameraCount: 1, cameras: [{ name: 'Nursery' }] };
    },
    showSchemaForm() { state.showSchema++; },
    addEventListener(name, handler) { state.listeners[name] = handler; },
  };
  const context = vm.createContext({
    window: { homebridge, LollipopSetupConfig: { configureAccount } },
    document: { getElementById: byId, querySelectorAll: () => [], createElement: () => new Element() },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/setup.js'), 'utf8'), context);
  return { state, byId };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('browser sign-in supports OTP retry, safely displays camera names, and saves credential-free configuration', async () => {
  const browser = createBrowser({
    initialConfig: [{ platform: 'Lollipop', lollipops: [{ name: 'Preserved camera' }] }],
    request(route, body) {
      if (route === '/account/login') return { requiresOtp: true };
      if (body.code !== '123456') throw { message: secret, error: { code: 'INVALID_OTP' } };
      return { authenticated: true, cameraCount: 1, cameras: [{ name: '<script>not HTML</script>' }] };
    },
  });
  await settle();
  browser.byId('account-email').value = email;
  browser.byId('account-password').value = secret;
  browser.byId('login-form').dispatch('submit');
  assert.equal(browser.byId('account-password').value, '');
  await settle();
  assert.equal(browser.byId('otp-form').hidden, false);
  assert.equal(browser.state.saves, 0);
  browser.byId('account-code').value = '000000';
  browser.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(browser.byId('otp-form').hidden, false);
  assert.doesNotMatch(browser.byId('setup-message').textContent, /synthetic-password/);
  assert.match(browser.byId('setup-message').textContent, /not accepted/);
  browser.byId('account-code').value = '123456';
  browser.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(browser.byId('otp-form').hidden, true);
  assert.equal(browser.byId('account-code').value, '');
  assert.equal(browser.state.saves, 1);
  assert.deepEqual(browser.state.configs[0].account, { email });
  assert.equal(browser.state.configs[0].cameraDefaults.enableSoundMachine, true);
  assert.equal(browser.state.configs[0].lollipops[0].name, 'Preserved camera');
  assert.equal(browser.byId('camera-list').children[0].textContent, '<script>not HTML</script>');
  assert.doesNotMatch(JSON.stringify(browser.state.updates), /synthetic-password|123456|000000/);
  browser.byId('advanced-settings').dispatch('click');
  browser.byId('advanced-settings').dispatch('click');
  assert.equal(browser.state.showSchema, 1);
});

test('a configuration save failure can be retried without sending a password or OTP again', async () => {
  const browser = createBrowser({ saveError: true });
  await settle();
  browser.byId('account-email').value = email;
  browser.byId('account-password').value = secret;
  browser.byId('login-form').dispatch('submit');
  await settle();
  assert.equal(browser.byId('save-account').hidden, false);
  assert.equal(browser.byId('account-connected').hidden, false);
  assert.match(browser.byId('setup-message').textContent, /could not save/);
  assert.doesNotMatch(browser.byId('setup-message').textContent, /synthetic-password/);
  browser.state.saveError = false;
  browser.byId('save-account').dispatch('click');
  await settle();
  assert.equal(browser.state.saves, 1);
  assert.equal(browser.state.requests.length, 1);
  assert.equal(browser.byId('save-account').hidden, true);
});
