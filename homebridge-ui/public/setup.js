(function () {
  'use strict';

  const bridge = window.homebridge;
  const byId = id => document.getElementById(id);
  const emailInput = byId('account-email');
  const passwordInput = byId('account-password');
  const codeInput = byId('account-code');
  const loginForm = byId('login-form');
  const otpForm = byId('otp-form');
  const connectedPanel = byId('account-connected');
  const debugInput = byId('debug-logging');
  let debugEnabled = false;
  let accountEmail = '';
  let pendingEmail = '';
  let lastAccountResult = null;
  let busy = false;
  let schemaShown = false;

  const messages = {
    INVALID_INPUT: 'Check your email, password, or six-digit verification code.',
    INVALID_ACCOUNT: 'Enter the email address for your Lollipop account.',
    INVALID_CREDENTIALS: 'Lollipop did not accept that email and password. Try again.',
    INVALID_SESSION: 'Your saved session has expired. Sign in again.',
    SIGN_IN_REQUIRED: 'Sign in to connect your Lollipop account.',
    OTP_REQUIRED: 'Sign in to receive a new verification code.',
    OTP_NOT_STARTED: 'Sign in again to request a verification code.',
    NO_OTP_CHALLENGE: 'Sign in again to request a verification code.',
    INVALID_OTP: 'That verification code was not accepted. Try again, or sign in again for a new code.',
    NETWORK_ERROR: 'Unable to reach Lollipop. Check the connection and try again.',
    SERVICE_UNAVAILABLE: 'Lollipop is temporarily unavailable. Try again shortly.',
    RATE_LIMITED: 'Lollipop has limited account requests. Wait before trying again.',
    TLS_ERROR: 'The Lollipop service certificate could not be verified.',
    ACCESS_DENIED: 'Lollipop did not authorize this account request. Check the account in the Lollipop app.',
    INVALID_RESPONSE: 'Lollipop returned an unexpected response. Try again or check the plugin documentation.',
    STORAGE_ERROR: 'Homebridge could not save or read the session. Check its storage permissions.',
    REQUEST_IN_PROGRESS: 'Wait for the current request to finish.',
    CONFIG_CONFLICT: 'Lollipop has conflicting account or child-bridge entries. Back up config.json and consolidate those entries before saving. No configuration was changed.',
  };

  function message(text, kind) {
    const element = byId('setup-message');
    element.textContent = text;
    element.className = 'alert alert-' + (kind || 'info');
    element.hidden = !text;
  }

  function report(error) {
    const code = error && ((error.error && error.error.code) || error.code);
    message(messages[code] || 'Unable to complete setup. Try again.', 'danger');
  }

  function request(route, payload) {
    return bridge.request(route, { ...payload, debug: debugEnabled });
  }

  function readDebug(config) {
    debugEnabled = Boolean(config && config.debug === true);
    debugInput.checked = debugEnabled;
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.lollipop-setup button, #debug-logging').forEach(control => { control.disabled = true; });
    try {
      await operation();
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      document.querySelectorAll('.lollipop-setup button, #debug-logging').forEach(control => { control.disabled = false; });
    }
  }

  debugInput.addEventListener('change', () => {
    if (busy) {
      debugInput.checked = debugEnabled;
      return;
    }
    debugEnabled = debugInput.checked === true;
    run(async () => {
      const status = byId('debug-status');
      status.textContent = 'Saving debug logging setting…';
      try {
        // Read the latest form state so changing debug cannot discard a camera,
        // account setting, or an edit made in the advanced form.
        const configs = await bridge.getPluginConfig();
        await bridge.updatePluginConfig(window.LollipopSetupConfig.configureDebug(configs, debugEnabled));
        await bridge.savePluginConfig();
        status.textContent = 'Debug logging ' + (debugEnabled ? 'enabled' : 'disabled')
          + '. Restart the Lollipop child bridge or Homebridge to apply it to running cameras.';
      } catch (error) {
        if (error && error.code === 'CONFIG_CONFLICT') {
          status.textContent = messages.CONFIG_CONFLICT;
          return;
        }
        status.textContent = 'Debug logging is ' + (debugEnabled ? 'on' : 'off')
          + ' for this setup screen, but Homebridge could not save the setting. Change it again to retry saving.';
      }
    });
  });

  function showCameras(result) {
    connectedPanel.hidden = false;
    loginForm.hidden = true;
    otpForm.hidden = true;
    byId('connected-heading').textContent = 'Connected as ' + accountEmail;
    const list = byId('camera-list');
    list.replaceChildren();
    if (result.discoveryPending) {
      byId('camera-summary').textContent = 'Signed in. Camera discovery is temporarily unavailable; refresh to try again.';
      return;
    }
    const count = result.cameraCount;
    byId('camera-summary').textContent = count
      ? count + (count === 1 ? ' camera found.' : ' cameras found.') + ' Homebridge will connect all account cameras.'
      : 'No cameras were found. Check that your cameras are paired with this account in the Lollipop app, then refresh.';
    (result.cameras || []).forEach(camera => {
      const item = document.createElement('li');
      item.textContent = camera.name;
      list.appendChild(item);
    });
  }

  async function saveAccount() {
    try {
      // Read the latest form state before updating so advanced edits stay intact.
      const configs = await bridge.getPluginConfig();
      await bridge.updatePluginConfig(window.LollipopSetupConfig.configureAccount(configs, accountEmail));
      await bridge.savePluginConfig();
    } catch (error) {
      byId('save-account').hidden = false;
      message(error && error.code === 'CONFIG_CONFLICT' ? messages.CONFIG_CONFLICT
        : 'Signed in, but Homebridge could not save the configuration. Retry saving your account.', 'danger');
      return;
    }
    byId('save-account').hidden = true;
    message(lastAccountResult.discoveryPending
      ? 'Account saved. You can retry camera discovery here, or restart Homebridge to connect.'
      : 'Account saved. Restart Homebridge to connect your cameras and sound-machine switches.',
    lastAccountResult.discoveryPending ? 'warning' : 'success');
  }

  async function connected(result, email) {
    if (!result || result.authenticated !== true) throw new Error('Unexpected setup result');
    accountEmail = email.trim().toLowerCase();
    emailInput.value = accountEmail;
    passwordInput.value = '';
    codeInput.value = '';
    pendingEmail = '';
    lastAccountResult = result;
    showCameras(result);
    await saveAccount();
  }

  loginForm.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    passwordInput.value = '';
    run(async () => {
      message('Signing in…');
      const result = await request('/account/login', { email, password });
      if (result.requiresOtp) {
        pendingEmail = email;
        loginForm.hidden = true;
        connectedPanel.hidden = true;
        otpForm.hidden = false;
        message('Check your email for Lollipop\'s verification code.');
        codeInput.focus();
      } else {
        await connected(result, email);
      }
    });
  });

  otpForm.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const code = codeInput.value.trim();
      codeInput.value = '';
      message('Verifying code…');
      const result = await request('/account/otp', { email: pendingEmail, code });
      await connected(result, pendingEmail);
    });
  });

  function showLogin() {
    loginForm.hidden = false;
    connectedPanel.hidden = true;
    otpForm.hidden = true;
    codeInput.value = '';
    passwordInput.value = '';
    pendingEmail = '';
    message('');
    passwordInput.focus();
  }

  byId('cancel-otp').addEventListener('click', () => run(async () => {
    await request('/account/cancel', {});
    showLogin();
  }));
  byId('sign-in-again').addEventListener('click', showLogin);
  byId('save-account').addEventListener('click', () => run(saveAccount));
  byId('refresh-cameras').addEventListener('click', () => run(async () => {
    message('Checking your account cameras…');
    const result = await request('/account/status', { email: accountEmail });
    showCameras(result);
    message(result.discoveryPending ? 'Camera discovery is still unavailable. Try again shortly.'
      : result.cached ? 'Using saved account information while Lollipop is unavailable.' : '', 'warning');
  }));
  byId('advanced-settings').addEventListener('click', () => {
    if (!schemaShown) {
      bridge.showSchemaForm();
      schemaShown = true;
      byId('advanced-settings').textContent = 'Camera preferences and advanced settings are shown below';
    }
  });

  bridge.addEventListener('configChanged', event => {
    if (!event || !Array.isArray(event.data)) return;
    const config = event.data.find(item => item.platform === 'Lollipop');
    readDebug(config);
    if (busy || pendingEmail) return;
    const nextEmail = config && config.account && typeof config.account.email === 'string'
      ? config.account.email.trim().toLowerCase() : '';
    if (nextEmail !== accountEmail) {
      accountEmail = nextEmail;
      emailInput.value = nextEmail;
      showLogin();
      message(nextEmail ? 'Sign in to connect the account selected in advanced settings.'
        : 'Account sign-in is off. Save these settings to use the manual camera configuration.');
    }
  });

  run(async () => {
    const configs = await bridge.getPluginConfig();
    const config = configs.find(item => item.platform === 'Lollipop');
    readDebug(config);
    if (config && config.account && typeof config.account.email === 'string') {
      emailInput.value = config.account.email;
      accountEmail = config.account.email.trim().toLowerCase();
      message('Checking your saved account…');
      const result = await request('/account/status', { email: accountEmail });
      showCameras(result);
      message(result.discoveryPending ? 'Signed in. Camera discovery is temporarily unavailable.'
        : result.cached ? 'Using saved account information while Lollipop is unavailable.' : '', 'warning');
    }
  });
})();
