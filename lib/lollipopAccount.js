'use strict';

const https = require('https');
const net = require('net');
const crypto = require('crypto');
const tls = require('tls');
const { AccountStore } = require('./accountStore');

const API_BASE = 'https://parse-api.lollipop.camera/parse';
const APPLICATION_ID = 'WVxA1yrfGc8Jx9xNLyb0dX9005CI7cIThUFPSglD';
const IDENTITY_TTL = 12 * 60 * 60 * 1000;
const CAMERA_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PEM_BYTES = 128 * 1024;
const MESSAGES = Object.freeze({
    INVALID_ACCOUNT: 'Enter the email address for your Lollipop account.',
    INVALID_CREDENTIALS: 'Lollipop did not accept the email address or password.',
    INVALID_SESSION: 'The Lollipop session is no longer valid. Sign in again in the plugin settings.',
    SIGN_IN_REQUIRED: 'Sign in to Lollipop in the plugin settings.',
    OTP_REQUIRED: 'Lollipop needs the verification code sent to your email. Complete sign-in in the plugin settings.',
    INVALID_OTP: 'Lollipop did not accept the verification code. Check the code or sign in again for a new code.',
    NO_OTP_CHALLENGE: 'Start sign-in before entering a verification code.',
    NETWORK_ERROR: 'The Lollipop service could not be reached. Check the network and try again.',
    SERVICE_UNAVAILABLE: 'The Lollipop service is temporarily unavailable. Try again later.',
    RATE_LIMITED: 'Lollipop has limited account requests. Wait before trying again.',
    TLS_ERROR: 'The HTTPS certificate could not be verified.',
    INVALID_RESPONSE: 'Lollipop returned an unexpected response.',
    ACCESS_DENIED: 'Lollipop did not authorize this account request.',
    STORAGE_ERROR: 'The private Lollipop account data could not be saved or read.',
    CHECKSUM_MISMATCH: 'The downloaded MQTT credentials failed their integrity check.',
    INVALID_CERTIFICATE: 'Lollipop returned an invalid MQTT certificate or private key.',
    UNKNOWN_CAMERA: 'This camera was not found in the signed-in account.',
    CLOSED: 'The Lollipop account connection has been closed.'
});

class LollipopAccountError extends Error {
    constructor(code) {
        const knownCode = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : 'INVALID_RESPONSE';
        super(MESSAGES[knownCode]);
        this.name = 'LollipopAccountError';
        this.code = knownCode;
    }
}
const failure = code => new LollipopAccountError(code);
const validToken = token => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(token);
const validId = id => typeof id === 'string' && /^[a-z\d_-]{1,128}$/i.test(id);
const transient = error => error && ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(error.code);
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function installationId() {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function validateIdentity(cert, key, now) {
    if (!cert.includes(Buffer.from('-----BEGIN CERTIFICATE-----')) || !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(key.toString('utf8'))) throw failure('INVALID_CERTIFICATE');
    let socket;
    try {
        const secureContext = tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
        // Node 14 can inspect a local certificate through an unconnected socket.
        // This does not open a network connection or need X509Certificate.
        socket = new tls.TLSSocket(undefined, { secureContext });
        const details = socket.getCertificate();
        const from = Date.parse(details && details.valid_from);
        const to = Date.parse(details && details.valid_to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to) throw failure('INVALID_CERTIFICATE');
    } catch (_) { throw failure('INVALID_CERTIFICATE'); }
    finally { if (socket) socket.destroy(); }
}

function host(value) {
    if (typeof value !== 'string' || !value || value.length > 253 || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
    const unwrapped = value.replace(/^\[|\]$/g, '');
    if (net.isIP(unwrapped) === 6 && (value === unwrapped || value === '[' + unwrapped + ']')) return unwrapped;
    if (net.isIP(value) === 4) return value;
    if (/^[\d.]+$/.test(value)) return undefined;
    if (value.replace(/\.$/, '').split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return value;
    return undefined;
}

// In the Android Camera model, internal_live_url is named internalLiveIp. It is
// normally a bare local address. Accept a complete authenticated RTSP URL too,
// while keeping its opaque path and query intact for versions that provide one.
function normalizeCamera(record) {
    if (!record || typeof record !== 'object' || !validId(record.objectId)) throw failure('INVALID_RESPONSE');
    const rawName = typeof record.name === 'string' ? record.name : '';
    const name = rawName.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64) || 'Lollipop Camera';
    const camera = { cameraId: record.objectId, name };
    const address = record.internal_live_url;
    camera.ip = host(address);
    if (!camera.ip && typeof address === 'string' && !/[\s\u0000-\u001f\u007f]/.test(address)) {
        try {
            const url = new URL(address);
            if (['rtsp:', 'rtsps:'].includes(url.protocol) && !url.hash) {
                camera.ip = host(url.hostname);
                if (camera.ip && url.username && url.password) camera.rtspUrl = url.href;
            }
        } catch (_) { /* An offline camera can legitimately have no address. */ }
    }
    return camera;
}

function safeHttpsUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw failure('INVALID_RESPONSE'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw failure('INVALID_RESPONSE');
    return url;
}

function networkFailure(error) {
    if (error instanceof LollipopAccountError) return error;
    const code = typeof (error && error.code) === 'string' ? error.code : '';
    if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)) return failure('TLS_ERROR');
    return failure('NETWORK_ERROR');
}

// Transport injection uses this same contract in tests: one bounded HTTPS
// response {statusCode, headers, body: Buffer}. Redirects are handled only by
// the credential downloader; account headers are never sent to download URLs.
function requestHttps(options) {
    return new Promise((resolve, reject) => {
        const url = safeHttpsUrl(options.url);
        let settled = false;
        let request;
        const finish = (error, response) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (options.onFinish && request) options.onFinish(request);
            if (error) reject(networkFailure(error)); else resolve(response);
        };
        const timer = setTimeout(() => {
            const error = failure('NETWORK_ERROR');
            finish(error);
            if (request) request.destroy(error);
        }, options.timeoutMs || 15000);
        try {
            request = https.request(url, {
                method: options.method || 'GET', headers: options.headers || {}, minVersion: 'TLSv1.2'
            }, response => {
                const chunks = [];
                let size = 0;
                response.on('data', chunk => {
                    size += chunk.length;
                    if (size > options.maxBytes) {
                        const error = failure('INVALID_RESPONSE');
                        finish(error);
                        response.destroy(error);
                        request.destroy(error);
                    } else chunks.push(chunk);
                });
                response.on('error', error => finish(error));
                response.on('aborted', () => finish(failure('NETWORK_ERROR')));
                response.on('end', () => finish(undefined, {
                    statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)
                }));
            });
            request.on('error', error => finish(error));
            if (options.onRequest) options.onRequest(request);
            request.end(options.body);
        } catch (error) { finish(error); }
    });
}

class LollipopAccount {
    constructor(options = {}) {
        if (typeof options.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email.trim()) || /[\u0000-\u001f\u007f]/.test(options.email) || options.email.length > 254) throw failure('INVALID_ACCOUNT');
        if (typeof options.storagePath !== 'string' || !options.storagePath) throw failure('STORAGE_ERROR');
        this.email = options.email.trim().toLowerCase();
        this._password = typeof options.password === 'string' ? options.password : undefined;
        this._configuredToken = validToken(options.sessionToken) ? options.sessionToken : undefined;
        this._store = new AccountStore(options.storagePath, this.email);
        this._request = options.request || requestHttps;
        this._now = options.now || Date.now;
        this._state = undefined;
        this._loading = undefined;
        this._otp = undefined;
        this._closed = false;
        this._requests = new Set();
        this._authenticating = undefined;
        this._validatedToken = undefined;
        this.usingCachedCameras = false;
        this.lastCameraSource = undefined;
    }

    async _update(change) {
        try { this._state = await this._store.update(change); }
        catch (_) { throw failure('STORAGE_ERROR'); }
        return this._state;
    }

    async _load(refresh = false) {
        if (this._closed) throw failure('CLOSED');
        if (this._loading) return this._loading;
        if (this._state && !refresh) return this._state;
        this._loading = (async () => {
            let state;
            try { state = await this._store.read(); } catch (_) { throw failure('STORAGE_ERROR'); }
            if (!state || state.version !== 1 || typeof state.installationId !== 'string') {
                state = await this._update(current => ({
                    version: 1,
                    installationId: typeof current.installationId === 'string' ? current.installationId : installationId()
                }));
            }
            if (this._configuredToken) {
                const token = this._configuredToken;
                this._configuredToken = undefined;
                state = await this._update(current => current.sessionToken === token ? current : {
                    version: 1, installationId: current.installationId, sessionToken: token
                });
            }
            this._state = state;
            return state;
        })();
        try { return await this._loading; } finally { this._loading = undefined; }
    }

    async _send(options) {
        if (this._closed) throw failure('CLOSED');
        safeHttpsUrl(options.url);
        let result;
        try {
            result = await this._request({
                timeoutMs: 15000, ...options,
                onRequest: request => { this._requests.add(request); if (this._closed) request.destroy(failure('CLOSED')); },
                onFinish: request => this._requests.delete(request)
            });
        } catch (error) { throw networkFailure(error); }
        if (this._closed) throw failure('CLOSED');
        if (!result || !Number.isInteger(result.statusCode)) throw failure('INVALID_RESPONSE');
        const body = Buffer.isBuffer(result.body) ? result.body : typeof result.body === 'string' ? Buffer.from(result.body) : undefined;
        if (!body || body.length > options.maxBytes) throw failure('INVALID_RESPONSE');
        return { ...result, body };
    }

    async _invalidate(token) {
        this._validatedToken = undefined;
        this._otp = undefined;
        await this._update(current => current.sessionToken && current.sessionToken !== token ? current : {
            version: 1, installationId: current.installationId
        });
    }

    async _api(endpoint, payload, token, authKind) {
        const state = await this._load();
        const headers = {
            Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
            'X-Parse-Application-Id': APPLICATION_ID, 'X-Requested-With': 'android',
            'X-Parse-Installation-Id': state.installationId
        };
        if (token) headers['X-Parse-Session-Token'] = token;
        const response = await this._send({
            url: API_BASE + endpoint, method: payload === undefined ? 'GET' : 'POST', headers,
            body: payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)), maxBytes: MAX_JSON_BYTES
        });
        let body;
        try { body = JSON.parse(response.body.toString('utf8')); } catch (_) { /* Status still matters for outages. */ }
        const parseCode = body && typeof body.code === 'number' ? body.code : undefined;
        if (token && (response.statusCode === 401 || parseCode === 209 || parseCode === 206)) {
            await this._invalidate(token);
            throw failure('INVALID_SESSION');
        }
        if (token && (response.statusCode === 403 || parseCode === 119)) {
            throw failure('ACCESS_DENIED');
        }
        if (response.statusCode === 429) throw failure('RATE_LIMITED');
        if (response.statusCode >= 500) throw failure('SERVICE_UNAVAILABLE');
        if (response.statusCode < 200 || response.statusCode >= 300 || (body && typeof body.error === 'string')) {
            if (authKind === 'login') throw failure('INVALID_CREDENTIALS');
            if (authKind === 'otp') throw failure('INVALID_OTP');
            throw failure('ACCESS_DENIED');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('INVALID_RESPONSE');
        return body;
    }

    _result(body) {
        let result = body.result;
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (_) { throw failure('INVALID_RESPONSE'); }
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('INVALID_RESPONSE');
        return result;
    }

    async _saveSession(token) {
        this._otp = undefined;
        this._validatedToken = token;
        await this._update(current => ({
            version: 1, installationId: current.installationId, sessionToken: token, validatedAt: this._now()
        }));
    }

    async signIn(password) {
        await this._load(true);
        if (typeof password !== 'string' || !password) throw failure('INVALID_CREDENTIALS');
        this._otp = undefined;
        const result = this._result(await this._api('/functions/loginV2', {
            username: this.email, password, deviceType: 'android'
        }, undefined, 'login'));
        if (validToken(result.sessionToken)) {
            await this._saveSession(result.sessionToken);
            return { authenticated: true };
        }
        if (Number.isSafeInteger(result.timestamp) && result.timestamp > 0) {
            this._otp = { timestamp: result.timestamp };
            return { requiresOtp: true };
        }
        throw failure('INVALID_RESPONSE');
    }

    async verifyOtp(code) {
        await this._load();
        if (!this._otp) throw failure('NO_OTP_CHALLENGE');
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw failure('INVALID_OTP');
        const result = this._result(await this._api('/functions/userFinishLoginOTP', {
            username: this.email, timestamp: this._otp.timestamp, otpCode: code, deviceType: 'android'
        }, undefined, 'otp'));
        if (!validToken(result.sessionToken)) throw failure('INVALID_RESPONSE');
        await this._saveSession(result.sessionToken);
        return { authenticated: true };
    }

    async authenticate() {
        if (this._authenticating) return this._authenticating;
        this._authenticating = (async () => {
            const state = await this._load(true);
            if (validToken(state.sessionToken)) {
                const token = state.sessionToken;
                try {
                    const user = await this._api('/users/me', undefined, token);
                    if (!validId(user.objectId)) throw failure('INVALID_RESPONSE');
                    this._validatedToken = token;
                    await this._update(current => current.sessionToken === token ? { ...current, validatedAt: this._now() } : current);
                    return { authenticated: true };
                } catch (error) {
                    if (transient(error) && typeof state.validatedAt === 'number' && this._now() - state.validatedAt <= CAMERA_CACHE_TTL) {
                        return { authenticated: true, cached: true };
                    }
                    if (error.code !== 'INVALID_SESSION') throw error;
                }
            }
            if (!this._password) throw failure('SIGN_IN_REQUIRED');
            const result = await this.signIn(this._password);
            if (result.requiresOtp) throw failure('OTP_REQUIRED');
            return result;
        })();
        try { return await this._authenticating; } finally { this._authenticating = undefined; }
    }

    async _session() {
        await this._load(true);
        if (!validToken(this._state.sessionToken)) throw failure(this._otp ? 'OTP_REQUIRED' : 'SIGN_IN_REQUIRED');
        return this._state.sessionToken;
    }

    _cachedCameras() {
        const state = this._state;
        if (!Array.isArray(state.cameras) || typeof state.camerasAt !== 'number' || this._now() - state.camerasAt > CAMERA_CACHE_TTL) return undefined;
        return state.cameras.map(camera => normalizeCamera({
            objectId: camera.cameraId, name: camera.name, internal_live_url: camera.rtspUrl || camera.ip
        }));
    }

    async listCameras() {
        const token = await this._session();
        this.usingCachedCameras = false;
        this.lastCameraSource = undefined;
        try {
            const cameras = [];
            const seen = new Set();
            const limit = 100;
            for (let page = 0; page < 100; page++) {
                const query = new URLSearchParams({ limit: String(limit), skip: String(page * limit), order: 'objectId', include: 'cam_setting' });
                const response = await this._api('/classes/camera?' + query.toString(), undefined, token);
                if (!Array.isArray(response.results) || response.results.length > limit) throw failure('INVALID_RESPONSE');
                for (const record of response.results) {
                    const camera = normalizeCamera(record);
                    if (seen.has(camera.cameraId)) throw failure('INVALID_RESPONSE');
                    seen.add(camera.cameraId);
                    cameras.push(camera);
                }
                if (response.results.length < limit) {
                    await this._update(current => {
                        if (current.sessionToken !== token) return current;
                        const identities = Object.create(null);
                        for (const camera of cameras) {
                            if (current.identities && Object.prototype.hasOwnProperty.call(current.identities, camera.cameraId)) identities[camera.cameraId] = current.identities[camera.cameraId];
                        }
                        return { ...current, cameras, camerasAt: this._now(), identities };
                    });
                    if (this._state.sessionToken !== token) throw failure('INVALID_SESSION');
                    this.lastCameraSource = 'cloud';
                    return clone(cameras);
                }
            }
            throw failure('INVALID_RESPONSE');
        } catch (error) {
            if (transient(error) && this._state.sessionToken === token) {
                const cameras = this._cachedCameras();
                if (cameras) {
                    this.usingCachedCameras = true;
                    this.lastCameraSource = 'cache';
                    return clone(cameras);
                }
            }
            throw error;
        }
    }

    _identity(cameraId, freshOnly) {
        const identities = this._state.identities;
        const value = identities && Object.prototype.hasOwnProperty.call(identities, cameraId) && identities[cameraId];
        if (!value || typeof value.savedAt !== 'number' || this._now() - value.savedAt > (freshOnly ? IDENTITY_TTL : CAMERA_CACHE_TTL)) return undefined;
        if (typeof value.cert !== 'string' || typeof value.key !== 'string') return undefined;
        const cert = Buffer.from(value.cert, 'base64');
        const key = Buffer.from(value.key, 'base64');
        if (cert.length > MAX_PEM_BYTES || key.length > MAX_PEM_BYTES || md5(cert) !== value.certChecksum || md5(key) !== value.keyChecksum) return undefined;
        try { validateIdentity(cert, key, this._now()); } catch (_) { return undefined; }
        return { cert, key };
    }

    async _download(value) {
        let url = safeHttpsUrl(value);
        for (let redirects = 0; redirects <= 3; redirects++) {
            const response = await this._send({ url: url.href, method: 'GET', headers: {}, maxBytes: MAX_PEM_BYTES });
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                if (redirects === 3 || !response.headers || typeof response.headers.location !== 'string') throw failure('INVALID_RESPONSE');
                try { url = safeHttpsUrl(new URL(response.headers.location, url).href); }
                catch (_) { throw failure('INVALID_RESPONSE'); }
                continue;
            }
            if (response.statusCode >= 500) throw failure('SERVICE_UNAVAILABLE');
            if (response.statusCode !== 200) throw failure('ACCESS_DENIED');
            return response.body;
        }
        throw failure('INVALID_RESPONSE');
    }

    async getMqttCredentials(cameraId, { force = false } = {}) {
        const token = await this._session();
        if (!validId(cameraId) || !Array.isArray(this._state.cameras) || !this._state.cameras.some(camera => camera.cameraId === cameraId)) throw failure('UNKNOWN_CAMERA');
        if (!force) {
            const cached = this._identity(cameraId, true);
            if (cached) return cached;
        }
        try {
            const links = this._result(await this._api('/functions/getCameraMQTTKeyLink', { cameraId, version: '0' }, token));
            if (typeof links.certChecksum !== 'string' || !/^[a-f\d]{32}$/i.test(links.certChecksum) || typeof links.keyChecksum !== 'string' || !/^[a-f\d]{32}$/i.test(links.keyChecksum)) throw failure('INVALID_RESPONSE');
            const [cert, key] = await Promise.all([this._download(links.cert), this._download(links.key)]);
            const certChecksum = md5(cert);
            const keyChecksum = md5(key);
            if (certChecksum !== links.certChecksum.toLowerCase() || keyChecksum !== links.keyChecksum.toLowerCase()) throw failure('CHECKSUM_MISMATCH');
            validateIdentity(cert, key, this._now());
            await this._update(current => current.sessionToken !== token ? current : {
                ...current,
                identities: { ...current.identities, [cameraId]: {
                    cert: cert.toString('base64'), key: key.toString('base64'), certChecksum, keyChecksum, savedAt: this._now()
                } }
            });
            if (this._state.sessionToken !== token) throw failure('INVALID_SESSION');
            return { cert, key };
        } catch (error) {
            if (error.code === 'ACCESS_DENIED') {
                // A forbidden camera operation does not revoke the account's
                // session or its access to other cameras. Retire only this
                // camera's cached identity, so later calls cannot reuse it.
                await this._update(current => {
                    if (current.sessionToken !== token) return current;
                    const identities = { ...current.identities };
                    delete identities[cameraId];
                    return { ...current, identities };
                });
            }
            if (!force && transient(error) && this._state.sessionToken === token) {
                const cached = this._identity(cameraId, false);
                if (cached) return cached;
            }
            throw error;
        }
    }

    close() {
        this._closed = true;
        this._otp = undefined;
        this._password = undefined;
        for (const request of this._requests) request.destroy(failure('CLOSED'));
        this._requests.clear();
    }
}

module.exports = { LollipopAccount, LollipopAccountError, AccountError: LollipopAccountError, normalizeCamera, requestHttps };
