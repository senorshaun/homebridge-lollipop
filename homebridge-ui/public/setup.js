'use strict';

(() => {
  const hb = window.homebridge;
  const button = document.getElementById('sign-in');
  const status = document.getElementById('account-status');
  let form, busy = false, debug = false, authenticatedEmail;

  async function configuration() {
    const blocks = await hb.getPluginConfig();
    if (!Array.isArray(blocks) || blocks.some(c => !c || typeof c !== 'object' || Array.isArray(c)))
      throw Object.assign(new Error(), { code: 'CONFIG_CONFLICT' });
    const matches = blocks.map((c, i) => !c.accessory &&
      (!c.platform || c.platform === 'Lollipop' || c.platform === 'homebridge-lollipop.Lollipop') ? i : -1)
      .filter(i => i >= 0);
    // Never create a duplicate or guess which of two child bridges to keep.
    if (matches.length > 1) throw Object.assign(new Error(), { code: 'CONFIG_CONFLICT' });
    const index = matches[0] ?? blocks.length;
    return { blocks, index, config: blocks[index] || { platform: 'Lollipop' } };
  }

  function settings() {
    form?.end();
    form = undefined;
    hb.showSchemaForm();
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try { await action(); }
    catch (e) {
      const code = e?.error?.code || e?.code;
      status.textContent = ({
        INVALID_CREDENTIALS: 'Email or password not accepted. Try again.',
        INVALID_OTP: 'Verification code not accepted. Try again.',
        OTP_NOT_STARTED: 'Start sign-in again to request a verification code.',
        INVALID_SESSION: 'Session expired. Sign in again.',
        NETWORK_ERROR: 'Could not reach Lollipop. Try again.',
        RATE_LIMITED: 'Lollipop has limited requests. Wait before trying again.',
        CONFIG_CONFLICT: 'Multiple or invalid Lollipop entries. Check the Homebridge configuration before continuing.'
      })[code] || 'Sign-in could not complete. Check the Homebridge UI logs and retry.';
    } finally { busy = false; button.disabled = false; }
  }

  async function applyAccount() {
    const { blocks, index, config } = await configuration();
    const updated = [...blocks];
    updated[index] = { ...config, platform: 'Lollipop', account: { email: authenticatedEmail } };
    // Homebridge's Save button is the only disk writer. Preserve _bridge and preferences.
    await hb.updatePluginConfig(updated);
    authenticatedEmail = undefined;
    button.textContent = 'Sign in / reconnect';
    settings();
    status.textContent = 'Signed in. Click Save below, then restart the Lollipop child bridge or Homebridge.';
  }

  function credentials(email = '', verification = false) {
    form?.end();
    const properties = verification ? {
      code: { title: 'Email verification code', type: 'string', pattern: '^[0-9]{6}$', maxLength: 6, required: true }
    } : {
      email: { title: 'Lollipop email', type: 'string', format: 'email', maxLength: 254, required: true },
      password: { title: 'Password', type: 'string', format: 'password', maxLength: 4096, required: true }
    };
    form = hb.createForm({ schema: { type: 'object', properties } }, verification ? {} : { email },
      verification ? 'Verify' : 'Sign in', 'Cancel');
    form.onSubmit(data => run(async () => {
      const accountEmail = verification ? email : data.email.trim().toLowerCase();
      const payload = verification ? { email, code: data.code } : { email: accountEmail, password: data.password };
      form.end();
      form = undefined;
      status.textContent = verification ? 'Verifying code…' : 'Signing in…';
      let result;
      try {
        result = await hb.request(verification ? '/account/otp' : '/account/login', { ...payload, debug });
      } catch (error) {
        credentials(accountEmail, verification);
        throw error;
      }
      if (result?.requiresOtp) {
        credentials(accountEmail, true);
        status.textContent = 'Enter the verification code sent to your email.';
      } else if (result?.authenticated === true) {
        authenticatedEmail = accountEmail;
        button.textContent = 'Finish account setup';
        settings();
        await applyAccount();
      } else {
        credentials(accountEmail);
        throw new Error('Unexpected authentication response');
      }
    }));
    form.onCancel(() => run(async () => {
      settings();
      status.textContent = '';
      await hb.request('/account/cancel', { debug });
    }));
  }

  button.addEventListener('click', () => run(async () => {
    if (authenticatedEmail) return applyAccount();
    const { config } = await configuration();
    debug = config.debug === true;
    status.textContent = '';
    credentials(typeof config.account?.email === 'string' ? config.account.email : '');
  }));
  hb.showSchemaForm();
})();
