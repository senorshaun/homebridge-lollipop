'use strict';

const { Logger } = require('../lib/logger');

const ROUTES = ['/account/login', '/account/otp', '/account/status', '/account/cancel'];

const MESSAGES = Object.freeze({
  INVALID_INPUT: 'Enter a valid email address and password, or a six-digit verification code.',
  INVALID_ACCOUNT: 'Enter the email address for your Lollipop account.',
  INVALID_CREDENTIALS: 'Lollipop did not accept those credentials. Check your email and password.',
  INVALID_SESSION: 'Your saved Lollipop session has expired. Sign in again below.',
  SIGN_IN_REQUIRED: 'Sign in to connect your Lollipop account.',
  OTP_REQUIRED: 'Finish signing in with the verification code sent to your email.',
  OTP_NOT_STARTED: 'Start with your email and password before entering a verification code.',
  NO_OTP_CHALLENGE: 'Sign in again to request a verification code.',
  INVALID_OTP: 'Lollipop did not accept that verification code. Try again, or request a new code by signing in again.',
  NETWORK_ERROR: 'Unable to reach Lollipop. Check the connection and try again.',
  SERVICE_UNAVAILABLE: 'Lollipop is temporarily unavailable. Try again shortly.',
  RATE_LIMITED: 'Lollipop has limited account requests. Wait before trying again.',
  TLS_ERROR: 'The Lollipop service certificate could not be verified.',
  ACCESS_DENIED: 'Lollipop did not authorize this account request. Check the account in the Lollipop app.',
  INVALID_RESPONSE: 'Lollipop returned an unexpected response. Try again or check the plugin documentation.',
  CAMERA_ADDRESS_UNAVAILABLE: 'Lollipop has not reported a local address for this camera yet.',
  STORAGE_ERROR: 'Homebridge could not save or read your Lollipop session. Check its storage permissions.',
  CHECKSUM_MISMATCH: 'The camera credentials could not be verified. Try again.',
  REQUEST_IN_PROGRESS: 'Wait for the current request to finish before trying again.',
  ACCOUNT_ERROR: 'Unable to complete the Lollipop request. Try again.',
});

class AccountUiError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : 'ACCOUNT_ERROR';
    super(MESSAGES[safeCode]);
    this.code = safeCode;
  }
}

function safeError(error) {
  return new AccountUiError(error && error.code);
}

function readEmail(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.email !== 'string') {
    throw new AccountUiError('INVALID_INPUT');
  }
  const email = payload.email.trim().toLowerCase();
  if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountUiError('INVALID_INPUT');
  }
  return email;
}

/**
 * The UI process keeps only the active OTP challenge in memory. Account sessions
 * are managed by LollipopAccount in Homebridge's private storage, never config.json.
 * Every response is constructed explicitly so cloud credentials cannot reach the UI.
 */
class AccountController {
  constructor({ storagePath, Account, logger }) {
    this.storagePath = storagePath;
    this.Account = Account || require('../lib/lollipopAccount').LollipopAccount;
    this.logger = logger || new Logger({ info() {}, warn() {}, error() {}, debug() {} });
    this.pending = null;
    this.busy = false;
  }

  async handle(route, payload) {
    if (this.busy) throw new AccountUiError('REQUEST_IN_PROGRESS');
    this.busy = true;
    // The form sends a boolean on every request. Updating the shared logger also
    // changes diagnostics for an account retained during email verification.
    this.logger.debugMode = Boolean(payload && payload.debug === true);
    this.logger.addSecrets([payload && payload.email, payload && payload.password, payload && payload.code]);
    const routeName = ROUTES.includes(route) ? route : 'unknown';
    const started = Date.now();
    this.logger.diagnostic('setup.request.start', { route: routeName });
    const finish = result => {
      this.logger.diagnostic('setup.request.complete', {
        route: routeName,
        outcome: result.cancelled ? 'cancelled' : result.requiresOtp ? 'otp_required' : 'authenticated',
        durationMs: Date.now() - started,
        cameraCount: result.cameraCount,
        cached: result.cached,
        discoveryPending: result.discoveryPending,
        errorCode: result.discoveryError,
      });
      return result;
    };
    let activeAccount;
    try {
      if (route === '/account/cancel') {
        this.closePending();
        return finish({ cancelled: true });
      }

      const email = readEmail(payload);
      if (route === '/account/login') {
        if (typeof payload.password !== 'string' || !payload.password.length || payload.password.length > 4096) {
          throw new AccountUiError('INVALID_INPUT');
        }
        this.closePending();
        const account = this.createAccount(email);
        activeAccount = account;
        const result = await account.signIn(payload.password);
        if (result && result.requiresOtp === true) {
          this.pending = { email, account };
          return finish({ requiresOtp: true });
        }
        return finish(await this.complete(account, result));
      }

      if (route === '/account/otp') {
        if (typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code.trim())) {
          throw new AccountUiError('INVALID_INPUT');
        }
        if (!this.pending || this.pending.email !== email) throw new AccountUiError('OTP_NOT_STARTED');
        const account = this.pending.account;
        activeAccount = account;
        // Keep the challenge after a rejected code so a typo can be corrected.
        let result;
        try {
          result = await account.verifyOtp(payload.code.trim());
        } catch (error) {
          if (error && error.code === 'INVALID_CREDENTIALS') throw new AccountUiError('INVALID_OTP');
          throw error;
        }
        if (!result || result.authenticated !== true) throw new AccountUiError('INVALID_RESPONSE');
        this.pending = null;
        return finish(await this.complete(account, result));
      }

      if (route === '/account/status') {
        const account = this.createAccount(email);
        activeAccount = account;
        return finish(await this.complete(account, await account.authenticate()));
      }

      throw new AccountUiError('INVALID_INPUT');
    } catch (error) {
      const safe = safeError(error);
      this.logger.diagnostic('setup.request.failed', {
        route: routeName, errorCode: safe.code, durationMs: Date.now() - started,
      });
      throw safe;
    } finally {
      if (activeAccount && (!this.pending || this.pending.account !== activeAccount)) this.closeAccount(activeAccount);
      this.busy = false;
    }
  }

  createAccount(email) {
    return new this.Account({
      storagePath: this.storagePath,
      email,
      diagnostics: (event, fields) => this.logger.diagnostic(event, fields),
      registerSecrets: values => this.logger.addSecrets(values),
    });
  }

  closeAccount(account) {
    try {
      if (account && typeof account.close === 'function') account.close();
    } catch (_) {
      // Cleanup cannot replace a safe response with an external error payload.
    }
  }

  closePending() {
    const pending = this.pending;
    this.pending = null;
    if (pending) this.closeAccount(pending.account);
  }

  async complete(account, result) {
    if (!result || result.authenticated !== true) throw new AccountUiError('INVALID_RESPONSE');
    let cameras;
    try {
      cameras = await account.listCameras();
      if (!Array.isArray(cameras)) throw new AccountUiError('INVALID_RESPONSE');
    } catch (error) {
      const safe = safeError(error);
      if (['INVALID_SESSION', 'INVALID_CREDENTIALS', 'SIGN_IN_REQUIRED', 'ACCESS_DENIED', 'OTP_REQUIRED'].includes(safe.code)) throw safe;
      // Signing in has already saved the session. A camera-list outage should not
      // make the user enter their password again or discard the successful login.
      return {
        authenticated: true,
        cached: result.cached === true,
        discoveryPending: true,
        discoveryError: safe.code,
      };
    }
    return {
      authenticated: true,
      cached: result.cached === true || account.usingCachedCameras === true,
      cameraCount: cameras.length,
      cameras: cameras.map(camera => ({
        name: camera && typeof camera.name === 'string'
          ? camera.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) || 'Lollipop'
          : 'Lollipop',
      })),
    };
  }
}

module.exports = { AccountController, AccountUiError };
