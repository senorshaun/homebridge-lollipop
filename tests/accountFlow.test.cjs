'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { LollipopAccount } = require('../lib/lollipopAccount');
const { createEnvironment } = require('./helpers.cjs');

test('saved OTP sign-in flows through real account discovery and PEM provisioning into platform video and sound control', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lollipop-account-flow-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=synthetic-account-flow', '-keyout', path.join(directory, 'key.pem'),
        '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(directory, 'cert.pem'));
    const key = fs.readFileSync(path.join(directory, 'key.pem'));
    const md5 = value => crypto.createHash('md5').update(value).digest('hex');
    const email = 'synthetic-owner@example.invalid';
    const token = 'r:synthetic-account-flow-session';
    const camera = { objectId: 'flowcamera01', name: 'Nursery', internal_live_url: '192.0.2.83' };
    const calls = [];
    let mode = 'online';
    const json = (body, statusCode = 200) => ({ statusCode, headers: {}, body: Buffer.from(JSON.stringify(body)) });
    const request = async options => {
        const url = new URL(options.url);
        calls.push({ path: url.pathname, headers: options.headers });
        if (mode === 'outage') throw Object.assign(new Error('synthetic-private-network-detail'), { code: 'ECONNRESET' });
        if (mode === 'revoked') return json({ code: 209, error: 'synthetic-private-account-detail' }, 401);
        switch (url.pathname) {
            case '/parse/functions/loginV2':
                assert.equal(JSON.parse(options.body).deviceType, 'android');
                return json({ result: { timestamp: Date.now() + 120000, newOTP: true, id: 'syntheticotp' } });
            case '/parse/functions/userFinishLoginOTP':
                assert.equal(JSON.parse(options.body).otpCode, '001234');
                return json({ result: { objectId: 'flowowner01', sessionToken: token } });
            case '/parse/users/me':
                assert.equal(options.headers['X-Parse-Session-Token'], token);
                return json({ objectId: 'flowowner01' });
            case '/parse/classes/camera':
                assert.equal(options.headers['X-Parse-Session-Token'], token);
                return json({ results: [camera] });
            case '/parse/functions/getCameraMQTTKeyLink':
                assert.deepEqual(JSON.parse(options.body), { cameraId: camera.objectId, version: '0' });
                return json({ result: {
                    cert: 'https://synthetic-download.example.invalid/cert',
                    key: 'https://synthetic-download.example.invalid/key',
                    certChecksum: md5(cert), keyChecksum: md5(key)
                } });
            case '/cert':
                assert.deepEqual(options.headers, {});
                return { statusCode: 200, headers: {}, body: cert };
            case '/key':
                assert.deepEqual(options.headers, {});
                return { statusCode: 200, headers: {}, body: key };
            default: throw new Error('Unexpected synthetic endpoint');
        }
    };

    // The UI saves only the session in private storage. The platform receives
    // just the email, with no configured camera address, ID, or password.
    const uiAccount = new LollipopAccount({ storagePath: path.join(directory, 'lollipop'), email, request });
    assert.deepEqual(await uiAccount.signIn('synthetic-private-password'), { requiresOtp: true });
    await uiAccount.verifyOtp('001234');
    uiAccount.close();
    class Account extends LollipopAccount {
        constructor(options) { super({ ...options, request }); }
    }
    const env = createEnvironment({ Account, realSoundMachine: true });
    env.api.user.storagePath = () => directory;
    t.after(() => env.api.emit('shutdown'));
    const config = { account: { email } };
    const platform = env.createPlatform(config);
    await platform.didFinishLaunching();
    assert.equal(env.state.controllers.length, 1);
    assert.equal(platform.cameras.size, 1);
    assert.equal(env.state.mqtt.length, 1);
    const local = env.state.mqtt[0];
    assert.equal(local.url, 'mqtts://192.0.2.83:1883');
    assert.equal(local.options.username, 'lollipop');
    assert.equal(local.options.password, md5(camera.objectId + ':6A09E667BB67AE853C6EF372'));
    assert.ok(local.options.cert.equals(cert));
    assert.ok(local.options.key.equals(key));
    assert.equal(local.options.rejectUnauthorized, true);
    const runtimeCamera = [...platform.cameras.values()][0];
    assert.ok(runtimeCamera.config.source.includes(md5('homebridge:' + camera.objectId + ':6A09E667BB67AE853C6EF372')));
    const sound = Object.values(platform.accessories).find(accessory => accessory.getService(env.Service.Switch));
    assert.ok(sound);
    const on = sound.getService(env.Service.Switch).getCharacteristic(env.Characteristic.On);
    local.emit('connect');
    const responses = [];
    on.emit('set', true, error => responses.push(error));
    const publication = local.publications.find(item => item.topic === camera.objectId + '/controlMusic');
    assert.ok(publication);
    assert.equal(JSON.parse(publication.payload).params.playStatus, 'play');
    assert.equal(responses.length, 0);
    local.emit('message', camera.objectId + '/musicStatus/return', Buffer.from(JSON.stringify({ result: { playStatus: 'play' } })));
    assert.deepEqual(responses, [null]);
    assert.equal(on.value, true);

    // Cloud refresh supplies a changed DHCP address; the saved identity remains
    // usable and the existing HomeKit controller/switch retain their identity.
    camera.internal_live_url = '192.0.2.84';
    await platform.refreshAccount();
    assert.equal(env.state.controllers.length, 1);
    assert.equal(env.state.mqtt[1].url, 'mqtts://192.0.2.84:1883');
    assert.equal(calls.filter(call => call.path.endsWith('/getCameraMQTTKeyLink')).length, 1);
    assert.equal(local.endCalls, 1);
    mode = 'outage';
    await platform.refreshAccount();
    assert.equal(platform.account.lastCameraSource, 'cache');
    assert.equal(env.state.unregistered.length, 0);
    assert.equal(env.state.mqtt[1].endCalls, 0);
    mode = 'revoked';
    await platform.refreshAccount();
    assert.equal(env.state.unregistered.length, 0);
    assert.equal(env.state.mqtt[1].endCalls, 0);
    assert.equal(env.state.timers.size, 0, 'Revocation needs sign-in rather than an unattended password retry');
    assert.doesNotMatch(JSON.stringify(env.state.logs), /synthetic-private|synthetic-account-flow-session|BEGIN (?:RSA )?PRIVATE KEY/);
    assert.doesNotMatch(JSON.stringify(Object.values(platform.accessories).map(accessory => accessory.context)), /sessionToken|BEGIN|password|private/i);
    assert.deepEqual(config, { account: { email } });
});
