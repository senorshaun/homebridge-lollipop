'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { LollipopAccount, LollipopAccountError, normalizeCamera } = require('../lib/lollipopAccount');
const { AccountStore } = require('../lib/accountStore');

const EMAIL = 'owner@example.invalid';
const TOKEN = 'r:synthetic-owner-session';
const PASSWORD = 'synthetic-private-password';
const CAMERA = { objectId: 'camera001', name: 'Nursery', internal_live_url: '192.168.1.52' };
let FIXED_NOW;
const roots = [];
let cert;
let key;

function temporary() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lollipop-account-'));
    roots.push(directory);
    return directory;
}

before(() => {
    const directory = temporary();
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
        '-subj', '/CN=synthetic-lollipop-client', '-keyout', path.join(directory, 'key.pem'),
        '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore' });
    cert = fs.readFileSync(path.join(directory, 'cert.pem'));
    key = fs.readFileSync(path.join(directory, 'key.pem'));
    FIXED_NOW = Date.now();
});

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function json(body, statusCode = 200) {
    return { statusCode, headers: {}, body: Buffer.from(JSON.stringify(body)) };
}

function environment(handler, options = {}) {
    const storagePath = options.storagePath || path.join(temporary(), 'lollipop');
    const calls = [];
    const request = async requestOptions => {
        calls.push(requestOptions);
        return handler(requestOptions, calls);
    };
    const account = new LollipopAccount({ storagePath, email: EMAIL, now: () => FIXED_NOW, ...options, request });
    return { account, storagePath, calls, request };
}

function apiPath(request) { return new URL(request.url).pathname; }
const digest = bytes => crypto.createHash('md5').update(bytes).digest('hex');

function identityResponse(asString = false) {
    const result = {
        cert: 'https://credentials.example.invalid/client-cert?signature=synthetic-secret',
        key: 'https://credentials.example.invalid/client-key?signature=synthetic-secret',
        certChecksum: digest(cert), keyChecksum: digest(key)
    };
    return json({ result: asString ? JSON.stringify(result) : result });
}

function standardHandler(request) {
    const pathname = apiPath(request);
    if (pathname === '/parse/functions/loginV2') return json({ result: { sessionToken: TOKEN } });
    if (pathname === '/parse/users/me') return json({ objectId: 'owner001', sessionToken: TOKEN });
    if (pathname === '/parse/classes/camera') return json({ results: [CAMERA] });
    if (pathname === '/parse/functions/getCameraMQTTKeyLink') return identityResponse();
    if (pathname === '/client-cert') return { statusCode: 200, headers: {}, body: cert };
    if (pathname === '/client-key') return { statusCode: 200, headers: {}, body: key };
    throw new Error('Unexpected synthetic request');
}

async function signedIn(handler = standardHandler, options = {}) {
    const env = environment(handler, options);
    await env.account.signIn(PASSWORD);
    await env.account.listCameras();
    return env;
}

async function stored(env) {
    const files = (await fs.promises.readdir(env.storagePath)).filter(file => file.endsWith('.json'));
    assert.equal(files.length, 1);
    const file = path.join(env.storagePath, files[0]);
    return { file, text: await fs.promises.readFile(file, 'utf8') };
}

function hasCode(code) {
    return error => error instanceof LollipopAccountError && error.code === code &&
        ![PASSWORD, TOKEN, 'synthetic-secret', 'BEGIN PRIVATE KEY'].some(secret => String(error).includes(secret));
}

test('camera discovery uses the APK raw-IP field and preserves IDs when an offline camera has no address', () => {
    assert.deepEqual(normalizeCamera(CAMERA), { cameraId: 'camera001', name: 'Nursery', ip: '192.168.1.52' });
    const offline = normalizeCamera({ ...CAMERA, name: 'Nursery\nRoom', internal_live_url: '' });
    assert.equal(offline.cameraId, CAMERA.objectId);
    assert.equal(offline.name, 'NurseryRoom');
    assert.equal(offline.ip, undefined);
    for (const address of ['999.2.3.4', 'user:pass@camera', 'camera:1883', 'camera/path', 'https://camera/path']) {
        assert.equal(normalizeCamera({ ...CAMERA, internal_live_url: address }).ip, undefined);
    }
    assert.equal(normalizeCamera({ ...CAMERA, internal_live_url: '[fd00::52]' }).ip, 'fd00::52');
    assert.throws(() => normalizeCamera({ ...CAMERA, objectId: '../wrong' }), hasCode('INVALID_RESPONSE'));
});

test('an authenticated RTSP URL from an account preserves its opaque path/query and supplies the MQTT host', () => {
    const rtspUrl = 'rtsp://user:p%3Ass@camera.local:554/live/opaque?token=a%2Bb';
    const camera = normalizeCamera({ ...CAMERA, internal_live_url: rtspUrl });
    assert.deepEqual(camera, { cameraId: CAMERA.objectId, name: CAMERA.name, ip: 'camera.local', rtspUrl });
});

test('Android login uses recovered fields and headers, saving a private session without persisting the password', async () => {
    const env = environment(standardHandler, { email: '  OWNER@example.invalid  ' });
    assert.deepEqual(await env.account.signIn(PASSWORD), { authenticated: true });
    assert.equal(env.calls.length, 1);
    const request = env.calls[0];
    assert.deepEqual(JSON.parse(request.body), { username: EMAIL, password: PASSWORD, deviceType: 'android' });
    assert.equal(request.url, 'https://parse-api.lollipop.camera/parse/functions/loginV2');
    assert.equal(request.headers['X-Requested-With'], 'android');
    assert.equal(request.headers['X-Parse-Application-Id'], 'WVxA1yrfGc8Jx9xNLyb0dX9005CI7cIThUFPSglD');
    assert.match(request.headers['X-Parse-Installation-Id'], /^[a-f\d-]{36}$/);
    assert.equal(request.headers['X-Parse-REST-API-Key'], undefined);
    assert.equal(request.headers['X-Parse-Session-Token'], undefined);
    const disk = await stored(env);
    const state = JSON.parse(disk.text);
    assert.equal(state.sessionToken, TOKEN);
    assert.equal(state.installationId, request.headers['X-Parse-Installation-Id']);
    assert.ok(!disk.text.includes(PASSWORD));
    assert.ok(!path.basename(disk.file).includes('owner'));
    assert.equal((await fs.promises.stat(env.storagePath)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(disk.file)).mode & 0o777, 0o600);
});

test('OTP preserves leading zeroes and its server timestamp without persisting the challenge or code', async () => {
    let otpAttempts = 0;
    const env = environment(request => {
        if (apiPath(request).endsWith('/loginV2')) return json({ result: { timestamp: 1777777777000, id: 'otp001', newOTP: true } });
        otpAttempts++;
        assert.deepEqual(JSON.parse(request.body), {
            username: EMAIL, timestamp: 1777777777000, otpCode: '001234', deviceType: 'android'
        });
        return otpAttempts === 1 ? json({ code: 141, error: 'synthetic-secret' }, 400) : json({ result: { objectId: 'owner001', sessionToken: TOKEN } });
    });
    assert.deepEqual(await env.account.signIn(PASSWORD), { requiresOtp: true });
    assert.ok(!(await stored(env)).text.includes('1777777777000'));
    await assert.rejects(env.account.verifyOtp('001234'), hasCode('INVALID_OTP'));
    assert.deepEqual(await env.account.verifyOtp('001234'), { authenticated: true });
    const disk = await stored(env);
    assert.ok(!disk.text.includes('001234'));
    assert.ok(!disk.text.includes(PASSWORD));
    await assert.rejects(env.account.verifyOtp('001234'), hasCode('NO_OTP_CHALLENGE'));
});

test('a restart validates the saved session and keeps the installation ID without a password', async () => {
    const env = await signedIn();
    const original = JSON.parse((await stored(env)).text);
    const restarted = environment(standardHandler, { storagePath: env.storagePath });
    assert.deepEqual(await restarted.account.authenticate(), { authenticated: true });
    assert.equal(restarted.calls.length, 1);
    assert.equal(apiPath(restarted.calls[0]), '/parse/users/me');
    assert.equal(restarted.calls[0].headers['X-Parse-Session-Token'], TOKEN);
    assert.equal(restarted.calls[0].headers['X-Parse-Installation-Id'], original.installationId);
});

test('a revoked session clears persisted camera and identity data instead of using cache', async () => {
    const env = await signedIn();
    await env.account.getMqttCredentials(CAMERA.objectId);
    const restarted = environment(() => json({ code: 209, error: TOKEN }, 400), { storagePath: env.storagePath });
    await assert.rejects(restarted.account.authenticate(), hasCode('SIGN_IN_REQUIRED'));
    const state = JSON.parse((await stored(env)).text);
    assert.equal(state.sessionToken, undefined);
    assert.equal(state.cameras, undefined);
    assert.equal(state.identities, undefined);
    await assert.rejects(restarted.account.getMqttCredentials(CAMERA.objectId), hasCode('SIGN_IN_REQUIRED'));
});

test('invalid sessions trigger at most one configured-password login attempt', async () => {
    const env = environment(request => apiPath(request).endsWith('/users/me') ?
        json({ code: 209, error: TOKEN }, 401) : json({ code: 101, error: PASSWORD }, 400),
    { sessionToken: TOKEN, password: PASSWORD });
    await assert.rejects(env.account.authenticate(), hasCode('INVALID_CREDENTIALS'));
    assert.equal(env.calls.length, 2);
});

test('configured-password authentication reports OTP once instead of retrying login', async () => {
    const env = environment(() => json({ result: { timestamp: 1777777777000 } }), { password: PASSWORD });
    await assert.rejects(env.account.authenticate(), hasCode('OTP_REQUIRED'));
    assert.equal(env.calls.length, 1);
});

test('camera enumeration fetches the next page and does not discard a camera with a missing IP', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ ...CAMERA, objectId: 'camera' + String(i).padStart(3, '0') }));
    const env = environment(request => {
        if (apiPath(request).endsWith('/loginV2')) return standardHandler(request);
        const url = new URL(request.url);
        assert.equal(url.searchParams.get('limit'), '100');
        assert.equal(url.searchParams.get('order'), 'objectId');
        assert.equal(url.searchParams.get('include'), 'cam_setting');
        return json({ results: url.searchParams.get('skip') === '0' ? pageOne : [{ ...CAMERA, objectId: 'camera100', internal_live_url: '' }] });
    });
    await env.account.signIn(PASSWORD);
    const cameras = await env.account.listCameras();
    assert.equal(cameras.length, 101);
    assert.equal(cameras[100].cameraId, 'camera100');
    assert.equal(cameras[100].ip, undefined);
    assert.equal(env.calls.length, 3);
    assert.equal(env.account.usingCachedCameras, false);
});

test('a repeated full camera page is rejected instead of looping or silently truncating', async () => {
    const records = Array.from({ length: 100 }, (_, i) => ({ ...CAMERA, objectId: 'camera' + i }));
    const env = environment(request => apiPath(request).endsWith('/loginV2') ? standardHandler(request) : json({ results: records }));
    await env.account.signIn(PASSWORD);
    await assert.rejects(env.account.listCameras(), hasCode('INVALID_RESPONSE'));
    assert.equal(env.calls.length, 3);
});

test('cloud outage fallback is explicit and excludes TLS errors, denied access, and expired metadata', async () => {
    const env = await signedIn();
    const offline = environment(() => { throw Object.assign(new Error(TOKEN), { code: 'ECONNRESET' }); }, { storagePath: env.storagePath });
    assert.deepEqual(await offline.account.authenticate(), { authenticated: true, cached: true });
    assert.equal((await offline.account.listCameras())[0].cameraId, CAMERA.objectId);
    assert.equal(offline.account.usingCachedCameras, true);
    assert.equal(offline.account.lastCameraSource, 'cache');
    const badTls = environment(() => { throw Object.assign(new Error(TOKEN), { code: 'CERT_HAS_EXPIRED' }); }, { storagePath: env.storagePath });
    await assert.rejects(badTls.account.listCameras(), hasCode('TLS_ERROR'));
    const expired = environment(() => json({}, 503), { storagePath: env.storagePath, now: () => FIXED_NOW + 8 * 86400000 });
    await assert.rejects(expired.account.listCameras(), hasCode('SERVICE_UNAVAILABLE'));
    const denied = environment(() => json({ error: TOKEN }, 403), { storagePath: env.storagePath });
    await assert.rejects(denied.account.listCameras(), hasCode('ACCESS_DENIED'));
    assert.equal(JSON.parse((await stored(env)).text).sessionToken, TOKEN);
});

test('MQTT provisioning verifies real PEM bytes, sends no account headers to downloads, and survives restart', async () => {
    const env = await signedIn(request => apiPath(request).endsWith('/getCameraMQTTKeyLink') ? identityResponse(true) : standardHandler(request));
    const identity = await env.account.getMqttCredentials(CAMERA.objectId);
    assert.ok(identity.cert.equals(cert));
    assert.ok(identity.key.equals(key));
    const provision = env.calls.find(request => apiPath(request).endsWith('/getCameraMQTTKeyLink'));
    assert.deepEqual(JSON.parse(provision.body), { cameraId: CAMERA.objectId, version: '0' });
    assert.equal(provision.headers['X-Parse-Session-Token'], TOKEN);
    for (const request of env.calls.filter(request => new URL(request.url).hostname === 'credentials.example.invalid')) {
        assert.deepEqual(request.headers, {});
    }
    const disk = await stored(env);
    assert.ok(!disk.text.includes('credentials.example.invalid'));
    assert.ok(!disk.text.includes('synthetic-secret'));
    const restarted = environment(() => { throw new Error('Cache should satisfy this call'); }, { storagePath: env.storagePath });
    const cached = await restarted.account.getMqttCredentials(CAMERA.objectId);
    assert.ok(cached.key.equals(key));
    assert.equal(restarted.calls.length, 0);
});

test('raw-byte checksum mismatch refuses line-ending-normalized credentials and saves no identity', async () => {
    const env = await signedIn(request => apiPath(request) === '/client-cert' ?
        { statusCode: 200, headers: {}, body: Buffer.from(cert.toString('utf8').replace(/\n/g, '\r\n')) } : standardHandler(request));
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId), hasCode('CHECKSUM_MISMATCH'));
    assert.deepEqual(JSON.parse((await stored(env)).text).identities, {});
});

test('correct checksums do not permit a mismatched private key', async () => {
    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' }
    }).privateKey;
    const env = await signedIn(request => {
        if (apiPath(request).endsWith('/getCameraMQTTKeyLink')) {
            const body = JSON.parse(identityResponse().body);
            body.result.keyChecksum = digest(Buffer.from(otherKey));
            return json(body);
        }
        return apiPath(request) === '/client-key' ? { statusCode: 200, headers: {}, body: Buffer.from(otherKey) } : standardHandler(request);
    });
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId), hasCode('INVALID_CERTIFICATE'));
});

test('credential redirects remain HTTPS and never receive the account session', async () => {
    const env = await signedIn(request => {
        if (apiPath(request) === '/client-cert') return { statusCode: 302, headers: { location: 'https://cdn.example.invalid/cert' }, body: Buffer.alloc(0) };
        if (apiPath(request) === '/cert') {
            assert.deepEqual(request.headers, {});
            return { statusCode: 200, headers: {}, body: cert };
        }
        return standardHandler(request);
    });
    await env.account.getMqttCredentials(CAMERA.objectId);
    const bad = environment(request => apiPath(request) === '/client-cert' ?
        { statusCode: 302, headers: { location: 'http://unsafe.example.invalid/synthetic-secret' }, body: Buffer.alloc(0) } : standardHandler(request),
    { storagePath: env.storagePath });
    await assert.rejects(bad.account.getMqttCredentials(CAMERA.objectId, { force: true }), hasCode('INVALID_RESPONSE'));
    assert.ok(bad.calls.every(request => request.url.startsWith('https://')));
});

test('expired credential cache can bridge a temporary outage but force refresh never returns rejected credentials', async () => {
    const env = await signedIn();
    await env.account.getMqttCredentials(CAMERA.objectId);
    const offline = environment(() => json({}, 503), { storagePath: env.storagePath, now: () => FIXED_NOW + 13 * 3600000 });
    assert.ok((await offline.account.getMqttCredentials(CAMERA.objectId)).cert.equals(cert));
    await assert.rejects(offline.account.getMqttCredentials(CAMERA.objectId, { force: true }), hasCode('SERVICE_UNAVAILABLE'));
});

test('a denied camera operation removes only that identity and preserves the session and another camera', async () => {
    const secondCamera = { ...CAMERA, objectId: 'camera002', name: 'Playroom', internal_live_url: '192.168.1.53' };
    let denyFirst = false;
    const env = await signedIn(request => {
        if (apiPath(request) === '/parse/classes/camera') return json({ results: [CAMERA, secondCamera] });
        if (apiPath(request).endsWith('/getCameraMQTTKeyLink') && denyFirst && JSON.parse(request.body).cameraId === CAMERA.objectId) {
            return json({ code: 119, error: 'synthetic-private-camera-permission' }, 403);
        }
        return standardHandler(request);
    });
    await env.account.getMqttCredentials(CAMERA.objectId);
    await env.account.getMqttCredentials(secondCamera.objectId);
    denyFirst = true;
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId, { force: true }), hasCode('ACCESS_DENIED'));
    const state = JSON.parse((await stored(env)).text);
    assert.equal(state.sessionToken, TOKEN);
    assert.equal(state.cameras.length, 2);
    assert.equal(state.identities[CAMERA.objectId], undefined);
    assert.ok(state.identities[secondCamera.objectId]);
    const previousCalls = env.calls.length;
    assert.ok((await env.account.getMqttCredentials(secondCamera.objectId)).key.equals(key));
    assert.equal(env.calls.length, previousCalls, 'The other camera retains its cached identity');
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId), hasCode('ACCESS_DENIED'));
    assert.equal(env.calls.length, previousCalls + 1, 'The denied camera must request authorization again instead of reusing its identity');
});

test('credential download and JSON response size limits also reject oversized injected responses', async () => {
    const tooLarge = environment(() => ({ statusCode: 200, headers: {}, body: Buffer.alloc(2 * 1024 * 1024 + 1) }));
    await assert.rejects(tooLarge.account.signIn(PASSWORD), hasCode('INVALID_RESPONSE'));
    const env = await signedIn(request => apiPath(request) === '/client-key' ?
        { statusCode: 200, headers: {}, body: Buffer.alloc(128 * 1024 + 1) } : standardHandler(request));
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId), hasCode('INVALID_RESPONSE'));
});

test('shared UI/runtime cache merges concurrent updates and keeps a newly signed-in session', async () => {
    const directory = temporary();
    const one = new AccountStore(directory, EMAIL);
    const two = new AccountStore(directory, EMAIL);
    await one.update(() => ({ version: 1, installationId: 'stable', sessionToken: 'old' }));
    await Promise.all([
        one.update(async current => { await new Promise(resolve => setTimeout(resolve, 30)); return { ...current, cameras: [CAMERA] }; }),
        two.update(current => ({ ...current, sessionToken: 'new' }))
    ]);
    const state = await one.read();
    assert.equal(state.sessionToken, 'new');
    assert.deepEqual(state.cameras, [CAMERA]);
    assert.deepEqual((await fs.promises.readdir(directory)).filter(name => /\.lock$|\.tmp$/.test(name)), []);
});

test('expired cached certificates are fetched again even when their cache timestamp is fresh', async () => {
    const env = await signedIn();
    await env.account.getMqttCredentials(CAMERA.objectId);
    const future = FIXED_NOW + 31 * 86400000;
    const store = new AccountStore(env.storagePath, EMAIL);
    await store.update(current => ({ ...current, identities: {
        ...current.identities, [CAMERA.objectId]: { ...current.identities[CAMERA.objectId], savedAt: future }
    } }));
    const restarted = environment(standardHandler, { storagePath: env.storagePath, now: () => future });
    await assert.rejects(restarted.account.getMqttCredentials(CAMERA.objectId), hasCode('INVALID_CERTIFICATE'));
    assert.ok(restarted.calls.some(request => apiPath(request).endsWith('/getCameraMQTTKeyLink')));
});

test('an old in-flight revocation response cannot erase a session just saved by the UI', async () => {
    const env = await signedIn();
    let release;
    const runtime = environment(() => new Promise(resolve => { release = resolve; }), { storagePath: env.storagePath });
    const discovery = runtime.account.listCameras();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const ui = environment(() => json({ result: { sessionToken: 'r:new-ui-session' } }), { storagePath: env.storagePath });
    await ui.account.signIn(PASSWORD);
    release(json({ code: 209, error: TOKEN }, 401));
    await assert.rejects(discovery, hasCode('INVALID_SESSION'));
    assert.equal(JSON.parse((await stored(env)).text).sessionToken, 'r:new-ui-session');
});

test('private store tightens existing permissions and refuses a symlinked account file', async () => {
    const env = await signedIn();
    const disk = await stored(env);
    await fs.promises.chmod(env.storagePath, 0o755);
    await fs.promises.chmod(disk.file, 0o644);
    const restarted = environment(standardHandler, { storagePath: env.storagePath });
    await restarted.account.authenticate();
    assert.equal((await fs.promises.stat(env.storagePath)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(disk.file)).mode & 0o777, 0o600);
    const target = path.join(temporary(), 'outside.json');
    await fs.promises.writeFile(target, disk.text);
    await fs.promises.unlink(disk.file);
    await fs.promises.symlink(target, disk.file);
    const symlinked = environment(standardHandler, { storagePath: env.storagePath });
    await assert.rejects(symlinked.account.authenticate(), hasCode('STORAGE_ERROR'));
    assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o644);
});

test('account errors never contain raw server bodies, malformed URLs, or credentials', async () => {
    for (const response of [json({ error: PASSWORD + TOKEN }, 400), { statusCode: 200, headers: {}, body: Buffer.from(PASSWORD) }]) {
        const env = environment(() => response);
        await assert.rejects(env.account.signIn(PASSWORD), error =>
            error instanceof LollipopAccountError && !String(error).includes(PASSWORD) && !String(error).includes(TOKEN));
    }
    const env = await signedIn(request => {
        if (apiPath(request).endsWith('/getCameraMQTTKeyLink')) {
            const response = JSON.parse(identityResponse().body);
            response.result.cert = 'https://username:synthetic-secret@credentials.example.invalid/file';
            return json(response);
        }
        return standardHandler(request);
    });
    await assert.rejects(env.account.getMqttCredentials(CAMERA.objectId), hasCode('INVALID_RESPONSE'));
});

test('shutdown blocks late HTTP results from saving an account session', async () => {
    let release;
    const env = environment(() => new Promise(resolve => { release = resolve; }));
    const login = env.account.signIn(PASSWORD);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    env.account.close();
    release(json({ result: { sessionToken: TOKEN } }));
    await assert.rejects(login, hasCode('CLOSED'));
    assert.equal(JSON.parse((await stored(env)).text).sessionToken, undefined);
});
