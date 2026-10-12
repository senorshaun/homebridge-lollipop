'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { AccountController } = require('../homebridge-ui/accountController');
const { configureAccount, configureDebug } = require('../homebridge-ui/public/config');
const { Logger } = require('../lib/logger');

const email = 'owner@example.com';
const secret = 'synthetic-password-not-for-logs';
const storagePath = '/synthetic/homebridge/lollipop';

function createController(overrides = {}) {
  const state = { options: [], passwords: [], codes: [], logs: [] };
  const logger = new Logger({
    info: message => state.logs.push(message),
    warn: message => state.logs.push(message),
    error: message => state.logs.push(message),
    debug: message => state.logs.push(message),
  }, false);
  class Account {
    constructor(options) { state.options.push(options); this.options = options; }
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
  return { state, logger, controller: new AccountController({ storagePath, Account, logger }) };
}

function assertAccountOptions(options) {
  assert.equal(options.length, 1);
  assert.equal(options[0].storagePath, storagePath);
  assert.equal(options[0].email, email);
  assert.equal(typeof options[0].diagnostics, 'function');
  assert.equal(typeof options[0].registerSecrets, 'function');
}

test('account UI login exchanges a password without returning cloud or camera credentials', async () => {
  const { state, controller } = createController();
  const result = await controller.handle('/account/login', { email: ' Owner@Example.com ', password: secret });
  assertAccountOptions(state.options);
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
  assertAccountOptions(state.options);
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

test('the debug toggle changes only its boolean setting and preserves account and manual camera configuration', () => {
  const original = [{ platform: 'AnotherPlugin', custom: true }, {
    platform: 'Lollipop', name: 'My cameras', debug: false,
    account: { email, password: secret, sessionToken: 'private-session' },
    cameraDefaults: { audio: false, enableSoundMachine: true },
    lollipops: [{ name: 'Manual camera', ip: '192.0.2.1', cameraId: 'private-camera-id' }],
    _bridge: { username: 'AA:BB:CC:DD:EE:FF' },
  }];
  const snapshot = JSON.stringify(original);
  const saved = configureDebug(original, true);
  assert.deepEqual(saved, [original[0], { ...original[1], debug: true }]);
  assert.equal(JSON.stringify(original), snapshot);
  for (const value of [undefined, null, 1, 'true', {}, []]) {
    assert.equal(configureDebug(saved, value)[1].debug, false);
  }
  assert.deepEqual(configureDebug([], true), [{ platform: 'Lollipop', name: 'Lollipop', debug: true }]);
});

test('setup diagnostics include account stages only for a true debug flag and do not expose credentials', async () => {
  const { controller, state, logger } = createController({
    async signIn() {
      this.options.registerSecrets(['private-session-value']);
      this.options.diagnostics('account.sign_in', { phase: 'start', hasPassword: true });
      return { authenticated: true };
    },
  });
  for (const debug of [undefined, null, false, 1, 'true', {}, []]) {
    await controller.handle('/account/login', { email, password: secret, debug });
  }
  assert.deepEqual(state.logs, []);
  await controller.handle('/account/login', { email, password: secret, debug: true });
  const logged = state.logs.join('\n');
  assert.match(logged, /setup\.request\.start/);
  assert.match(logged, /account\.sign_in/);
  assert.match(logged, /setup\.request\.complete/);
  assert.match(logged, /authenticated/);
  assert.match(logged, /cameraCount/);
  assert.doesNotMatch(logged, /owner@example\.com|synthetic-password|private-id|192\.0\.2|rtsp:/);
  assert.doesNotMatch(logger.formatMessage('private-session-value'), /private-session-value/);
  const count = state.logs.length;
  await controller.handle('/account/status', { email, debug: false });
  assert.equal(state.logs.length, count, 'Turning debugging off must not leave account diagnostics enabled');
});

test('changing debug on an OTP request changes the retained account logger before verification', async () => {
  const { controller, state } = createController({
    async signIn() { return { requiresOtp: true }; },
    async verifyOtp(code) {
      state.codes.push(code);
      this.options.diagnostics('account.sign_in', { phase: 'start', hasPassword: false });
      if (code !== '123456') throw Object.assign(new Error(secret), { code: 'INVALID_CREDENTIALS' });
      return { authenticated: true };
    },
  });
  await controller.handle('/account/login', { email, password: secret, debug: true });
  const enabledCount = state.logs.length;
  assert.ok(enabledCount > 0);
  await assert.rejects(controller.handle('/account/otp', { email, code: '000000', debug: false }), error => error.code === 'INVALID_OTP');
  assert.equal(state.logs.length, enabledCount, 'A pending OTP account must honor disabling diagnostics');
  await controller.handle('/account/otp', { email, code: '123456', debug: true });
  assert.ok(state.logs.length > enabledCount);
  assert.equal(state.options.length, 1, 'Debug changes must preserve the original OTP account');
  assert.doesNotMatch(state.logs.join('\n'), /123456|000000|synthetic-password|owner@example\.com/);
});

test('debug failure diagnostics retain safe codes without returning or logging vendor errors', async () => {
  for (const code of ['NETWORK_ERROR', 'unexpected-secret-code']) {
    const { controller, state } = createController({
      async signIn() {
        throw Object.assign(new Error(secret + ' https://keys.example/private?token=private-session'), { code });
      },
    });
    await assert.rejects(controller.handle('/account/login', { email, password: secret, debug: true }), error => {
      assert.equal(error.code, code === 'NETWORK_ERROR' ? code : 'ACCOUNT_ERROR');
      assert.doesNotMatch(error.stack, /synthetic-password|keys\.example|private-session|unexpected-secret/);
      return true;
    });
    const logged = state.logs.join('\n');
    assert.match(logged, /setup\.request\.failed/);
    assert.match(logged, /NETWORK_ERROR|ACCOUNT_ERROR/);
    assert.doesNotMatch(logged, /synthetic-password|keys\.example|private-session|unexpected-secret|owner@example\.com/);
  }
});

function createBrowser({ request, initialConfig = [], saveError = false } = {}) {
  class Element {
    constructor() { this.hidden = false; this.value = ''; this.checked = false; this.textContent = ''; this.handlers = {}; this.children = []; }
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
    window: { homebridge, LollipopSetupConfig: { configureAccount, configureDebug } },
    document: { getElementById: byId, querySelectorAll: () => [byId('debug-logging')], createElement: () => new Element() },
    console: Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map(name => [name, () => {
      throw new Error('Account setup must never print request or response data to the browser console');
    }])),
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

test('debug is available before sign-in and explains when runtime logging changes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
  assert.match(html, /id="debug-logging" type="checkbox"/);
  assert.ok(html.indexOf('id="debug-logging"') < html.indexOf('id="login-form"'));
  assert.match(html, /Sign-in diagnostics change immediately/);
  assert.match(html, /Restart the Lollipop child bridge or Homebridge/);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.schema.json'), 'utf8'));
  assert.equal(schema.schema.properties.debug.default, false);
});

test('browser debug toggle saves latest configuration before login and reloads the saved setting', async () => {
  const browser = createBrowser({
    initialConfig: [{ platform: 'Lollipop', lollipops: [{ name: 'Manual camera', cameraId: 'private-id' }] }],
    request() { return { requiresOtp: true }; },
  });
  await settle();
  assert.equal(browser.byId('debug-logging').checked, false);
  browser.state.configs[0].cameraDefaults = { audio: false, enableSoundMachine: false };
  browser.state.configs[0]._bridge = { username: 'AA:BB:CC:DD:EE:FF' };
  browser.byId('debug-logging').checked = true;
  browser.byId('debug-logging').dispatch('change');
  await settle();
  assert.equal(browser.state.saves, 1);
  assert.equal(browser.state.configs[0].debug, true);
  assert.equal(browser.state.configs[0].account, undefined);
  assert.equal(browser.state.configs[0].lollipops[0].cameraId, 'private-id');
  assert.deepEqual(browser.state.configs[0].cameraDefaults, { audio: false, enableSoundMachine: false });
  assert.equal(browser.state.configs[0]._bridge.username, 'AA:BB:CC:DD:EE:FF');
  assert.match(browser.byId('debug-status').textContent, /enabled.*Restart/);
  browser.byId('account-email').value = email;
  browser.byId('account-password').value = secret;
  browser.byId('login-form').dispatch('submit');
  await settle();
  assert.equal(browser.state.requests[0].route, '/account/login');
  assert.equal(browser.state.requests[0].body.debug, true, 'Debug must apply to the first sign-in request');
  assert.equal(browser.byId('account-password').value, '');
  assert.equal(browser.byId('otp-form').hidden, false);

  const reopened = createBrowser({ initialConfig: browser.state.configs });
  await settle();
  assert.equal(reopened.byId('debug-logging').checked, true);
  assert.equal(reopened.state.requests.length, 0);
  assert.equal(reopened.state.saves, 0, 'Loading a saved setting must not change configuration');
});

test('saved debug applies to automatic status and refresh, with a strict false fallback', async () => {
  for (const debug of [true, false, 'true']) {
    const browser = createBrowser({ initialConfig: [{ platform: 'Lollipop', account: { email }, debug }] });
    await settle();
    assert.equal(browser.byId('debug-logging').checked, debug === true);
    assert.equal(browser.state.requests[0].route, '/account/status');
    assert.equal(browser.state.requests[0].body.debug, debug === true);
    browser.byId('refresh-cameras').dispatch('click');
    await settle();
    assert.equal(browser.state.requests[1].body.debug, debug === true);
  }
});

test('browser debug changes during OTP preserve the challenge and reach verification and cancellation', async () => {
  const browser = createBrowser({
    initialConfig: [{ platform: 'Lollipop', debug: false }],
    request(route) {
      if (route === '/account/login') return { requiresOtp: true };
      if (route === '/account/cancel') return { cancelled: true };
      throw { message: secret, error: { code: 'INVALID_OTP' } };
    },
  });
  await settle();
  browser.byId('account-email').value = email;
  browser.byId('account-password').value = secret;
  browser.byId('login-form').dispatch('submit');
  await settle();
  assert.equal(browser.state.requests[0].body.debug, false);

  browser.byId('debug-logging').checked = true;
  browser.byId('debug-logging').dispatch('change');
  await settle();
  assert.equal(browser.byId('otp-form').hidden, false);
  browser.byId('account-code').value = '000000';
  browser.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(browser.state.requests[1].body.debug, true);
  assert.equal(browser.state.requests[1].body.email, email);

  // An advanced-form edit must synchronize the visible toggle even while an
  // email challenge is retained, without resetting the pending account.
  browser.state.listeners.configChanged({ data: [{ platform: 'Lollipop', debug: false }] });
  assert.equal(browser.byId('debug-logging').checked, false);
  assert.equal(browser.byId('otp-form').hidden, false);
  browser.byId('account-code').value = '000001';
  browser.byId('otp-form').dispatch('submit');
  await settle();
  assert.equal(browser.state.requests[2].body.debug, false);
  assert.equal(browser.state.requests[2].body.email, email);
  browser.byId('cancel-otp').dispatch('click');
  await settle();
  assert.equal(browser.state.requests[3].route, '/account/cancel');
  assert.equal(browser.state.requests[3].body.debug, false);
  assert.equal(browser.byId('login-form').hidden, false);
  assert.doesNotMatch(JSON.stringify(browser.state.updates), /synthetic-password|000000|000001/);
});

test('a debug-setting save error is safe and still applies to the next setup request', async () => {
  const browser = createBrowser({ saveError: true, request() { return { requiresOtp: true }; } });
  await settle();
  browser.byId('debug-logging').checked = true;
  browser.byId('debug-logging').dispatch('change');
  await settle();
  assert.equal(browser.byId('debug-logging').checked, true);
  assert.match(browser.byId('debug-status').textContent, /could not save/);
  assert.doesNotMatch(browser.byId('debug-status').textContent, /synthetic-password/);
  browser.byId('account-email').value = email;
  browser.byId('account-password').value = secret;
  browser.byId('login-form').dispatch('submit');
  await settle();
  assert.equal(browser.state.requests[0].body.debug, true);
  assert.equal(browser.state.saves, 0);
});
