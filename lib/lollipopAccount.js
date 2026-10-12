'use strict';

const https = require('https');
const net = require('net');
const crypto = require('crypto');
const tls = require('tls');
const { AccountStore } = require('./accountStore');
const { safeErrorCode } = require('./diagnostics');

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
const systemCode = error => safeErrorCode(error && error.code);
const accountCode = error => error instanceof LollipopAccountError ? error.code : 'INVALID_RESPONSE';
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const elapsed = start => Math.max(0, Date.now() - start);
const age = (now, savedAt) => typeof savedAt === 'number' && Number.isFinite(savedAt) ? now - savedAt : undefined;
function observe(callback, event, fields) {
    if (typeof callback === 'function') {
        try { callback(event, fields); } catch (_) { /* Diagnostics must never change account behavior. */ }
    }
}

function operationFor(endpoint) {
    if (endpoint === '/functions/loginV2') return 'login';
    if (endpoint === '/functions/userFinishLoginOTP') return 'otp';
    if (endpoint === '/users/me') return 'session';
    if (endpoint.startsWith('/classes/camera?')) return 'cameras';
    if (endpoint === '/functions/getCameraMQTTKeyLink') return 'mqtt_key';
    return 'account';
}

function installationId() {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function validateIdentity(cert, key, now, diagnostics) {
    const report = fields => observe(diagnostics, 'account.identity.validation', fields);
    if (!cert.includes(Buffer.from('-----BEGIN CERTIFICATE-----'))) {
        report({ phase: 'cert_parse', outcome: 'failure', reason: 'missing_pem_marker' });
        throw failure('INVALID_CERTIFICATE');
    }
    if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(key.toString('utf8'))) {
        report({ phase: 'key_parse', outcome: 'failure', reason: 'missing_pem_marker' });
        throw failure('INVALID_CERTIFICATE');
    }
    let socket;
    try {
        const secureContext = tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
        report({ phase: 'cert_parse', outcome: 'success' });
        report({ phase: 'key_parse', outcome: 'success' });
        report({ phase: 'pair_match', outcome: 'success', matches: true });
        // Node 14 can inspect a local certificate through an unconnected socket.
        // This does not open a network connection or need X509Certificate.
        socket = new tls.TLSSocket(undefined, { secureContext });
        const details = socket.getCertificate();
        const from = Date.parse(details && details.valid_from);
        const to = Date.parse(details && details.valid_to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to) {
            report({ phase: 'validity', outcome: 'failure', reason: !Number.isFinite(from) || !Number.isFinite(to) ?
                'invalid_date' : now < from ? 'not_yet_valid' : 'expired' });
            throw failure('INVALID_CERTIFICATE');
        }
        report({ phase: 'validity', outcome: 'success', daysRemaining: Math.floor((to - now) / 86400000) });
    } catch (error) {
        if (!(error instanceof LollipopAccountError)) report({
            phase: error.code === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' ? 'pair_match' : 'identity_parse',
            outcome: 'failure', reason: error.code === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' ? 'key_mismatch' : 'invalid_pem',
            systemCode: systemCode(error)
        });
        throw failure('INVALID_CERTIFICATE');
    }
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
        const finish = (error, response, reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (options.onFinish && request) options.onFinish(request);
            if (error) {
                observe(options.onDiagnostic, 'account.http.transport', {
                    reason: reason || 'request_failure', errorCode: networkFailure(error).code,
                    networkCode: reason === 'timeout' ? 'ETIMEDOUT' : systemCode(error)
                });
                reject(networkFailure(error));
            } else resolve(response);
        };
        const timer = setTimeout(() => {
            const error = failure('NETWORK_ERROR');
            finish(error, undefined, 'timeout');
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
                        finish(error, undefined, 'response_too_large');
                        response.destroy(error);
                        request.destroy(error);
                    } else chunks.push(chunk);
                });
                response.on('error', error => finish(error, undefined, 'response_failure'));
                response.on('aborted', () => finish(failure('NETWORK_ERROR'), undefined, 'response_aborted'));
                response.on('end', () => finish(undefined, {
                    statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)
                }));
            });
            request.on('error', error => finish(error));
            if (options.onRequest) options.onRequest(request);
            request.end(options.body);
        } catch (error) { finish(error, undefined, 'request_setup'); }
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
        this._diagnostics = options.diagnostics;
        this._registerSecrets = options.registerSecrets;
        this._cameraReferences = new Map();
        this._secrets([options.email, this.email, this._password, this._configuredToken]);
        this._diagnostic('account.created', { hasPassword: !!this._password, hasSession: !!this._configuredToken });
    }

    _diagnostic(event, fields) { observe(this._diagnostics, event, fields); }

    _secrets(values) {
        if (typeof this._registerSecrets !== 'function') return;
        const strings = values.filter(value => typeof value === 'string' && value.length > 0);
        if (strings.length) {
            try { this._registerSecrets(strings); } catch (_) { /* Redaction registration cannot affect sign-in. */ }
        }
    }

    cameraReference(cameraId) {
        if (!this._cameraReferences.has(cameraId)) this._cameraReferences.set(cameraId, 'camera-' + (this._cameraReferences.size + 1));
        return this._cameraReferences.get(cameraId);
    }

    _registerCamera(record, normalized = false) {
        if (!record || typeof record !== 'object') return;
        this._secrets(normalized ? [record.cameraId, record.name, record.ip, record.rtspUrl] :
            [record.objectId, record.name, record.internal_live_url]);
    }

    _registerState(state) {
        if (!state || typeof state !== 'object') return;
        this._secrets([state.sessionToken, state.installationId]);
        if (Array.isArray(state.cameras)) for (const camera of state.cameras) this._registerCamera(camera, true);
        if (state.identities && typeof state.identities === 'object') {
            for (const cameraId of Object.keys(state.identities)) {
                const identity = state.identities[cameraId];
                this._secrets([cameraId]);
                if (identity && typeof identity === 'object') this._secrets([identity.cert, identity.key, identity.certChecksum, identity.keyChecksum]);
            }
        }
    }

    async _update(change, details = {}) {
        const started = Date.now();
        try { this._state = await this._store.update(change); }
        catch (error) {
            this._diagnostic('account.cache.write', { scope: 'account', cacheType: 'state', ...details,
                outcome: 'failure', durationMs: elapsed(started), errorCode: 'STORAGE_ERROR', systemCode: systemCode(error) });
            throw failure('STORAGE_ERROR');
        }
        this._registerState(this._state);
        this._diagnostic('account.cache.write', { scope: 'account', cacheType: 'state', ...details,
            outcome: 'success', durationMs: elapsed(started) });
        return this._state;
    }

    async _load(refresh = false) {
        if (this._closed) throw failure('CLOSED');
        if (this._loading) {
            this._diagnostic('account.cache.read', { source: 'memory', outcome: 'in_flight', cacheType: 'state' });
            return this._loading;
        }
        if (this._state && !refresh) {
            this._diagnostic('account.cache.read', { source: 'memory', outcome: 'success', cacheType: 'state', hasSession: validToken(this._state.sessionToken) });
            return this._state;
        }
        this._loading = (async () => {
            let state;
            const started = Date.now();
            try { state = await this._store.read(); } catch (error) {
                this._diagnostic('account.cache.read', { source: 'disk', outcome: 'failure', cacheType: 'state',
                    durationMs: elapsed(started), errorCode: 'STORAGE_ERROR', systemCode: systemCode(error) });
                throw failure('STORAGE_ERROR');
            }
            this._registerState(state);
            this._diagnostic('account.cache.read', { source: 'disk', outcome: 'success', cacheType: 'state',
                durationMs: elapsed(started), hasSession: !!state && validToken(state.sessionToken),
                hasCameras: !!state && Array.isArray(state.cameras), count: state && Array.isArray(state.cameras) ? state.cameras.length : 0 });
            if (!state || state.version !== 1 || typeof state.installationId !== 'string') {
                state = await this._update(current => ({
                    version: 1,
                    installationId: typeof current.installationId === 'string' ? current.installationId : installationId()
                }), { reason: 'initialize' });
            }
            if (this._configuredToken) {
                const token = this._configuredToken;
                this._configuredToken = undefined;
                state = await this._update(current => current.sessionToken === token ? current : {
                    version: 1, installationId: current.installationId, sessionToken: token
                }, { cacheType: 'session', reason: 'configured_session' });
            }
            this._state = state;
            return state;
        })();
        try { return await this._loading; } finally { this._loading = undefined; }
    }

    async _send(options) {
        if (this._closed) throw failure('CLOSED');
        const operation = options.diagnosticOperation || 'account';
        const started = Date.now();
        this._secrets([options.url]);
        safeHttpsUrl(options.url);
        this._diagnostic('account.http.request', { operation, phase: 'start' });
        let result;
        try {
            result = await this._request({
                timeoutMs: 15000, ...options,
                onRequest: request => { this._requests.add(request); if (this._closed) request.destroy(failure('CLOSED')); },
                onFinish: request => this._requests.delete(request),
                onDiagnostic: (event, fields) => this._diagnostic('account.http.transport', {
                    operation, durationMs: elapsed(started),
                    reason: ['timeout', 'response_too_large', 'response_failure', 'response_aborted', 'request_failure', 'request_setup'].includes(fields && fields.reason) ? fields.reason : 'request_failure',
                    errorCode: fields && Object.prototype.hasOwnProperty.call(MESSAGES, fields.errorCode) ? fields.errorCode : 'NETWORK_ERROR',
                    networkCode: safeErrorCode(fields && fields.networkCode)
                })
            });
        } catch (error) {
            const mapped = networkFailure(error);
            this._diagnostic('account.http.error', { operation, phase: 'transport', durationMs: elapsed(started),
                errorCode: mapped.code, networkCode: systemCode(error) });
            throw mapped;
        }
        if (this._closed) {
            this._diagnostic('account.http.error', { operation, phase: 'response', errorCode: 'CLOSED', durationMs: elapsed(started) });
            throw failure('CLOSED');
        }
        if (!result || !Number.isInteger(result.statusCode)) {
            this._diagnostic('account.http.error', { operation, phase: 'response', reason: 'invalid_status',
                errorCode: 'INVALID_RESPONSE', durationMs: elapsed(started) });
            throw failure('INVALID_RESPONSE');
        }
        const body = Buffer.isBuffer(result.body) ? result.body : typeof result.body === 'string' ? Buffer.from(result.body) : undefined;
        const statusCode = result.statusCode >= 100 && result.statusCode <= 599 ? result.statusCode : undefined;
        if (!body || body.length > options.maxBytes) {
            this._diagnostic('account.http.error', { operation, phase: 'response', reason: !body ? 'invalid_body' : 'response_too_large',
                statusCode, bytes: body && body.length, errorCode: 'INVALID_RESPONSE', durationMs: elapsed(started) });
            throw failure('INVALID_RESPONSE');
        }
        this._diagnostic('account.http.response', { operation, statusCode, bytes: body.length, durationMs: elapsed(started) });
        return { ...result, body };
    }

    async _invalidate(token) {
        this._validatedToken = undefined;
        this._otp = undefined;
        await this._update(current => current.sessionToken && current.sessionToken !== token ? current : {
            version: 1, installationId: current.installationId
        }, { cacheType: 'session', reason: 'session_rejected' });
        this._diagnostic('account.cache.invalidate', { scope: 'account', cacheType: 'session',
            outcome: this._state.sessionToken && this._state.sessionToken !== token ? 'preserved_new_session' : 'success', reason: 'session_rejected' });
    }

    async _api(endpoint, payload, token, authKind) {
        const operation = operationFor(endpoint);
        const state = await this._load();
        const headers = {
            Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
            'X-Parse-Application-Id': APPLICATION_ID, 'X-Requested-With': 'android',
            'X-Parse-Installation-Id': state.installationId
        };
        if (token) headers['X-Parse-Session-Token'] = token;
        const response = await this._send({
            url: API_BASE + endpoint, method: payload === undefined ? 'GET' : 'POST', headers,
            body: payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)), maxBytes: MAX_JSON_BYTES,
            diagnosticOperation: operation
        });
        let body;
        try { body = JSON.parse(response.body.toString('utf8')); } catch (_) { /* Status still matters for outages. */ }
        const parseCode = body && typeof body.code === 'number' ? body.code : undefined;
        this._secrets(body && typeof body === 'object' ? [body.sessionToken, body.objectId] : []);
        this._diagnostic('account.response.structure', { operation,
            statusCode: response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : undefined,
            parseCode: Number.isInteger(parseCode) && parseCode >= 0 && parseCode <= 999 ? parseCode : undefined,
            bodyType: valueType(body), resultType: valueType(body && body.result), resultsType: valueType(body && body.results),
            objectIdType: valueType(body && body.objectId) });
        const rejectResponse = code => {
            this._diagnostic('account.http.rejected', { operation, phase: 'response', errorCode: code,
                statusCode: response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : undefined,
                parseCode: Number.isInteger(parseCode) && parseCode >= 0 && parseCode <= 999 ? parseCode : undefined });
            return failure(code);
        };
        if (token && (response.statusCode === 401 || parseCode === 209 || parseCode === 206)) {
            await this._invalidate(token);
            throw rejectResponse('INVALID_SESSION');
        }
        if (token && (response.statusCode === 403 || parseCode === 119)) {
            throw rejectResponse('ACCESS_DENIED');
        }
        if (response.statusCode === 429) throw rejectResponse('RATE_LIMITED');
        if (response.statusCode >= 500) throw rejectResponse('SERVICE_UNAVAILABLE');
        if (response.statusCode < 200 || response.statusCode >= 300 || (body && typeof body.error === 'string')) {
            if (authKind === 'login') throw rejectResponse('INVALID_CREDENTIALS');
            if (authKind === 'otp') throw rejectResponse('INVALID_OTP');
            throw rejectResponse('ACCESS_DENIED');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw rejectResponse('INVALID_RESPONSE');
        return body;
    }

    _result(body, operation = 'account') {
        let result = body.result;
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch (_) {
                this._diagnostic('account.response.result', { operation, resultType: 'string', valid: false, reason: 'invalid_json' });
                throw failure('INVALID_RESPONSE');
            }
        }
        const valid = !!result && typeof result === 'object' && !Array.isArray(result);
        if (valid) this._secrets([result.sessionToken, result.objectId, result.cert, result.key, result.certChecksum, result.keyChecksum]);
        this._diagnostic('account.response.result', { operation, resultType: valueType(result), valid,
            sessionTokenType: valueType(result && result.sessionToken), timestampType: valueType(result && result.timestamp),
            certType: valueType(result && result.cert), keyType: valueType(result && result.key),
            certChecksumType: valueType(result && result.certChecksum), keyChecksumType: valueType(result && result.keyChecksum) });
        if (!valid) throw failure('INVALID_RESPONSE');
        return result;
    }

    async _saveSession(token) {
        this._secrets([token]);
        this._otp = undefined;
        this._validatedToken = token;
        await this._update(current => ({
            version: 1, installationId: current.installationId, sessionToken: token, validatedAt: this._now()
        }), { cacheType: 'session', reason: 'session_saved' });
    }

    async signIn(password) {
        this._secrets([password]);
        this._diagnostic('account.sign_in', { phase: 'start', hasPassword: typeof password === 'string' && !!password });
        const started = Date.now();
        try {
            await this._load(true);
            if (typeof password !== 'string' || !password) throw failure('INVALID_CREDENTIALS');
            this._otp = undefined;
            const result = this._result(await this._api('/functions/loginV2', {
                username: this.email, password, deviceType: 'android'
            }, undefined, 'login'), 'login');
            if (validToken(result.sessionToken)) {
                await this._saveSession(result.sessionToken);
                this._diagnostic('account.sign_in', { phase: 'complete', authenticated: true, requiresOtp: false, durationMs: elapsed(started) });
                return { authenticated: true };
            }
            if (Number.isSafeInteger(result.timestamp) && result.timestamp > 0) {
                this._otp = { timestamp: result.timestamp };
                this._diagnostic('account.sign_in', { phase: 'complete', authenticated: false, requiresOtp: true, durationMs: elapsed(started) });
                return { requiresOtp: true };
            }
            throw failure('INVALID_RESPONSE');
        } catch (error) {
            this._diagnostic('account.sign_in', { phase: 'complete', outcome: 'failure', errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        }
    }

    async verifyOtp(code) {
        this._secrets([code]);
        this._diagnostic('account.otp', { phase: 'start', hasChallenge: !!this._otp });
        const started = Date.now();
        try {
            await this._load();
            if (!this._otp) throw failure('NO_OTP_CHALLENGE');
            if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw failure('INVALID_OTP');
            const result = this._result(await this._api('/functions/userFinishLoginOTP', {
                username: this.email, timestamp: this._otp.timestamp, otpCode: code, deviceType: 'android'
            }, undefined, 'otp'), 'otp');
            if (!validToken(result.sessionToken)) throw failure('INVALID_RESPONSE');
            await this._saveSession(result.sessionToken);
            this._diagnostic('account.otp', { phase: 'complete', authenticated: true, durationMs: elapsed(started) });
            return { authenticated: true };
        } catch (error) {
            this._diagnostic('account.otp', { phase: 'complete', outcome: 'failure', errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        }
    }

    async authenticate() {
        if (this._authenticating) {
            this._diagnostic('account.authenticate', { phase: 'start', outcome: 'in_flight' });
            return this._authenticating;
        }
        this._diagnostic('account.authenticate', { phase: 'start' });
        const started = Date.now();
        this._authenticating = (async () => {
            const state = await this._load(true);
            this._diagnostic('account.session', { phase: 'start', hasSession: validToken(state.sessionToken), hasPassword: !!this._password });
            if (validToken(state.sessionToken)) {
                const token = state.sessionToken;
                try {
                    const user = await this._api('/users/me', undefined, token);
                    if (!validId(user.objectId)) {
                        this._diagnostic('account.session', { phase: 'complete', outcome: 'failure', reason: 'invalid_user', objectIdType: valueType(user.objectId) });
                        throw failure('INVALID_RESPONSE');
                    }
                    this._validatedToken = token;
                    await this._update(current => current.sessionToken === token ? { ...current, validatedAt: this._now() } : current,
                        { cacheType: 'session', reason: 'session_validated' });
                    this._diagnostic('account.session', { phase: 'complete', outcome: 'success', source: 'cloud' });
                    return { authenticated: true };
                } catch (error) {
                    const eligible = transient(error) && typeof state.validatedAt === 'number' && this._now() - state.validatedAt <= CAMERA_CACHE_TTL;
                    this._diagnostic('account.cache.eligibility', { cacheType: 'session', source: 'cache', eligible,
                        ageMs: age(this._now(), state.validatedAt), ttlMs: CAMERA_CACHE_TTL, errorCode: accountCode(error) });
                    if (transient(error) && typeof state.validatedAt === 'number' && this._now() - state.validatedAt <= CAMERA_CACHE_TTL) {
                        this._diagnostic('account.session', { phase: 'complete', outcome: 'success', source: 'cache', cached: true });
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
        try {
            const result = await this._authenticating;
            this._diagnostic('account.authenticate', { phase: 'complete', outcome: 'success', cached: result.cached === true, durationMs: elapsed(started) });
            return result;
        } catch (error) {
            this._diagnostic('account.authenticate', { phase: 'complete', outcome: 'failure', errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        } finally { this._authenticating = undefined; }
    }

    async _session() {
        await this._load(true);
        if (!validToken(this._state.sessionToken)) {
            const code = this._otp ? 'OTP_REQUIRED' : 'SIGN_IN_REQUIRED';
            this._diagnostic('account.session', { phase: 'required', hasSession: false, errorCode: code });
            throw failure(code);
        }
        return this._state.sessionToken;
    }

    _cachedCameras() {
        const state = this._state;
        const eligible = Array.isArray(state.cameras) && typeof state.camerasAt === 'number' && this._now() - state.camerasAt <= CAMERA_CACHE_TTL;
        this._diagnostic('account.cache.eligibility', { cacheType: 'cameras', source: 'cache', eligible,
            ageMs: age(this._now(), state.camerasAt), ttlMs: CAMERA_CACHE_TTL, count: Array.isArray(state.cameras) ? state.cameras.length : 0 });
        if (!Array.isArray(state.cameras) || typeof state.camerasAt !== 'number' || this._now() - state.camerasAt > CAMERA_CACHE_TTL) return undefined;
        const cameras = state.cameras.map(camera => normalizeCamera({
            objectId: camera.cameraId, name: camera.name, internal_live_url: camera.rtspUrl || camera.ip
        }));
        for (const camera of cameras) this._registerCamera(camera, true);
        return cameras;
    }

    async listCameras() {
        this._diagnostic('account.cameras', { phase: 'start' });
        const started = Date.now();
        const token = await this._session();
        this.usingCachedCameras = false;
        this.lastCameraSource = undefined;
        try {
            const cameras = [];
            const seen = new Set();
            const limit = 100;
            for (let page = 0; page < 100; page++) {
                const query = new URLSearchParams({ limit: String(limit), skip: String(page * limit), order: 'objectId', include: 'cam_setting' });
                this._diagnostic('account.cameras.page', { phase: 'start', page: page + 1, limit });
                const response = await this._api('/classes/camera?' + query.toString(), undefined, token);
                if (!Array.isArray(response.results) || response.results.length > limit) {
                    this._diagnostic('account.cameras.page', { phase: 'complete', page: page + 1, outcome: 'failure',
                        reason: 'invalid_results', resultsType: valueType(response.results), count: Array.isArray(response.results) ? response.results.length : undefined });
                    throw failure('INVALID_RESPONSE');
                }
                let withAddress = 0;
                let withRtspUrl = 0;
                for (const record of response.results) {
                    this._registerCamera(record);
                    let camera;
                    try { camera = normalizeCamera(record); }
                    catch (error) {
                        this._diagnostic('account.camera', { phase: 'normalize', outcome: 'failure', reason: 'invalid_camera_record',
                            objectIdType: valueType(record && record.objectId), addressType: valueType(record && record.internal_live_url) });
                        throw error;
                    }
                    this._registerCamera(camera, true);
                    const cameraRef = this.cameraReference(camera.cameraId);
                    this._diagnostic('account.camera', { phase: 'normalize', outcome: 'success', cameraRef,
                        hasAddress: !!camera.ip, hasRtspUrl: !!camera.rtspUrl, addressType: valueType(record.internal_live_url) });
                    if (seen.has(camera.cameraId)) {
                        this._diagnostic('account.cameras.page', { phase: 'complete', page: page + 1, outcome: 'failure', reason: 'duplicate_id', cameraRef });
                        throw failure('INVALID_RESPONSE');
                    }
                    if (camera.ip) withAddress++;
                    if (camera.rtspUrl) withRtspUrl++;
                    seen.add(camera.cameraId);
                    cameras.push(camera);
                }
                this._diagnostic('account.cameras.page', { phase: 'complete', outcome: 'success', page: page + 1,
                    count: response.results.length, withAddress, withoutAddress: response.results.length - withAddress, withRtspUrl });
                if (response.results.length < limit) {
                    await this._update(current => {
                        if (current.sessionToken !== token) return current;
                        const identities = Object.create(null);
                        for (const camera of cameras) {
                            if (current.identities && Object.prototype.hasOwnProperty.call(current.identities, camera.cameraId)) identities[camera.cameraId] = current.identities[camera.cameraId];
                        }
                        return { ...current, cameras, camerasAt: this._now(), identities };
                    }, { cacheType: 'cameras', reason: 'camera_list_saved' });
                    if (this._state.sessionToken !== token) throw failure('INVALID_SESSION');
                    this.lastCameraSource = 'cloud';
                    this._diagnostic('account.cameras', { phase: 'complete', outcome: 'success', source: 'cloud',
                        count: cameras.length, durationMs: elapsed(started) });
                    return clone(cameras);
                }
            }
            this._diagnostic('account.cameras', { phase: 'pagination', outcome: 'failure', reason: 'page_limit' });
            throw failure('INVALID_RESPONSE');
        } catch (error) {
            if (transient(error) && this._state.sessionToken === token) {
                const cameras = this._cachedCameras();
                if (cameras) {
                    this.usingCachedCameras = true;
                    this.lastCameraSource = 'cache';
                    this._diagnostic('account.cameras', { phase: 'complete', outcome: 'success', source: 'cache', count: cameras.length,
                        cached: true, errorCode: accountCode(error), durationMs: elapsed(started) });
                    return clone(cameras);
                }
            }
            this._diagnostic('account.cameras', { phase: 'complete', outcome: 'failure', errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        }
    }

    _identity(cameraId, freshOnly) {
        const cameraRef = this.cameraReference(cameraId);
        const identities = this._state.identities;
        const value = identities && Object.prototype.hasOwnProperty.call(identities, cameraId) && identities[cameraId];
        const details = { cameraRef, scope: 'camera', cacheType: 'identity', source: 'cache',
            ttlMs: freshOnly ? IDENTITY_TTL : CAMERA_CACHE_TTL, ageMs: age(this._now(), value && value.savedAt) };
        const miss = reason => {
            this._diagnostic('account.cache.eligibility', { ...details, eligible: false, reason });
            return undefined;
        };
        if (!value || typeof value.savedAt !== 'number') return miss('missing');
        if (this._now() - value.savedAt > (freshOnly ? IDENTITY_TTL : CAMERA_CACHE_TTL)) return miss('expired');
        if (typeof value.cert !== 'string' || typeof value.key !== 'string') return miss('invalid_pem_storage');
        const cert = Buffer.from(value.cert, 'base64');
        const key = Buffer.from(value.key, 'base64');
        this._secrets([cert.toString('utf8'), key.toString('utf8')]);
        if (cert.length > MAX_PEM_BYTES || key.length > MAX_PEM_BYTES) return miss('response_too_large');
        if (md5(cert) !== value.certChecksum) return miss('cert_checksum_mismatch');
        if (md5(key) !== value.keyChecksum) return miss('key_checksum_mismatch');
        try {
            validateIdentity(cert, key, this._now(), (event, fields) => this._diagnostic(event, { cameraRef, source: 'cache', ...fields }));
        } catch (_) { return miss('invalid_certificate'); }
        this._diagnostic('account.cache.eligibility', { ...details, eligible: true, reason: 'valid', hasIdentity: true });
        return { cert, key };
    }

    async _download(value, file, cameraRef) {
        const operation = file === 'cert' ? 'cert_download' : 'key_download';
        const started = Date.now();
        this._secrets([value]);
        this._diagnostic('account.credential.download', { operation, file, cameraRef, phase: 'start' });
        let redirects = 0;
        let phase = 'url';
        try {
            let url = safeHttpsUrl(value);
            for (; redirects <= 3; redirects++) {
                phase = 'request';
                const response = await this._send({ url: url.href, method: 'GET', headers: {}, maxBytes: MAX_PEM_BYTES, diagnosticOperation: operation });
                this._diagnostic('account.credential.download', { operation, file, cameraRef, phase: 'response',
                    statusCode: response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : undefined,
                    bytes: response.body.length, redirects });
                if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                    phase = 'redirect';
                    if (redirects === 3 || !response.headers || typeof response.headers.location !== 'string') throw failure('INVALID_RESPONSE');
                    this._secrets([response.headers.location]);
                    try {
                        const next = new URL(response.headers.location, url).href;
                        this._secrets([next]);
                        url = safeHttpsUrl(next);
                    } catch (_) { throw failure('INVALID_RESPONSE'); }
                    continue;
                }
                phase = 'response';
                if (response.statusCode >= 500) throw failure('SERVICE_UNAVAILABLE');
                if (response.statusCode !== 200) throw failure('ACCESS_DENIED');
                this._secrets([response.body.toString('utf8'), response.body.toString('base64')]);
                this._diagnostic('account.credential.download', { operation, file, cameraRef, phase: 'complete', outcome: 'success',
                    bytes: response.body.length, redirects, durationMs: elapsed(started) });
                return response.body;
            }
            throw failure('INVALID_RESPONSE');
        } catch (error) {
            this._diagnostic('account.credential.download', { operation, file, cameraRef, phase, outcome: 'failure',
                redirects, errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        }
    }

    async getMqttCredentials(cameraId, { force = false } = {}) {
        this._secrets([cameraId]);
        const cameraRef = this.cameraReference(cameraId);
        const started = Date.now();
        this._diagnostic('account.identity', { phase: 'start', cameraRef, forced: !!force });
        const token = await this._session();
        if (!validId(cameraId) || !Array.isArray(this._state.cameras) || !this._state.cameras.some(camera => camera.cameraId === cameraId)) {
            this._diagnostic('account.identity', { phase: 'complete', cameraRef, outcome: 'failure', errorCode: 'UNKNOWN_CAMERA' });
            throw failure('UNKNOWN_CAMERA');
        }
        if (!force) {
            const cached = this._identity(cameraId, true);
            if (cached) {
                this._diagnostic('account.identity', { phase: 'complete', cameraRef, outcome: 'success', source: 'cache', cached: true, durationMs: elapsed(started) });
                return cached;
            }
        }
        try {
            this._diagnostic('account.identity', { phase: 'key_link', cameraRef, source: 'cloud' });
            const links = this._result(await this._api('/functions/getCameraMQTTKeyLink', { cameraId, version: '0' }, token), 'mqtt_key');
            if (typeof links.certChecksum !== 'string' || !/^[a-f\d]{32}$/i.test(links.certChecksum) || typeof links.keyChecksum !== 'string' || !/^[a-f\d]{32}$/i.test(links.keyChecksum)) {
                this._diagnostic('account.identity', { phase: 'checksum', cameraRef, outcome: 'failure', reason: 'invalid_checksum_format' });
                throw failure('INVALID_RESPONSE');
            }
            const [cert, key] = await Promise.all([this._download(links.cert, 'cert', cameraRef), this._download(links.key, 'key', cameraRef)]);
            const certChecksum = md5(cert);
            const keyChecksum = md5(key);
            this._secrets([certChecksum, keyChecksum]);
            this._diagnostic('account.identity.checksum', { cameraRef, file: 'cert', source: 'cloud', matches: certChecksum === links.certChecksum.toLowerCase() });
            this._diagnostic('account.identity.checksum', { cameraRef, file: 'key', source: 'cloud', matches: keyChecksum === links.keyChecksum.toLowerCase() });
            if (certChecksum !== links.certChecksum.toLowerCase() || keyChecksum !== links.keyChecksum.toLowerCase()) throw failure('CHECKSUM_MISMATCH');
            validateIdentity(cert, key, this._now(), (event, fields) => this._diagnostic(event, { cameraRef, source: 'cloud', ...fields }));
            await this._update(current => current.sessionToken !== token ? current : {
                ...current,
                identities: { ...current.identities, [cameraId]: {
                    cert: cert.toString('base64'), key: key.toString('base64'), certChecksum, keyChecksum, savedAt: this._now()
                } }
            }, { scope: 'camera', cacheType: 'identity', reason: 'identity_saved', cameraRef });
            if (this._state.sessionToken !== token) throw failure('INVALID_SESSION');
            this._diagnostic('account.identity', { phase: 'complete', cameraRef, outcome: 'success', source: 'cloud', durationMs: elapsed(started) });
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
                }, { scope: 'camera', cacheType: 'identity', reason: 'access_denied', cameraRef });
                this._diagnostic('account.cache.invalidate', { scope: 'camera', cacheType: 'identity', cameraRef,
                    reason: 'access_denied', outcome: this._state.sessionToken === token ? 'success' : 'preserved_new_session' });
            }
            if (!force && transient(error) && this._state.sessionToken === token) {
                const cached = this._identity(cameraId, false);
                if (cached) {
                    this._diagnostic('account.identity', { phase: 'complete', cameraRef, outcome: 'success', source: 'cache', cached: true,
                        errorCode: accountCode(error), durationMs: elapsed(started) });
                    return cached;
                }
            }
            this._diagnostic('account.identity', { phase: 'complete', cameraRef, outcome: 'failure', errorCode: accountCode(error), durationMs: elapsed(started) });
            throw error;
        }
    }

    close() {
        this._diagnostic('account.close', { phase: 'start', count: this._requests.size });
        this._closed = true;
        this._otp = undefined;
        this._password = undefined;
        for (const request of this._requests) request.destroy(failure('CLOSED'));
        this._requests.clear();
    }
}

module.exports = { LollipopAccount, LollipopAccountError, AccountError: LollipopAccountError, normalizeCamera, requestHttps };
