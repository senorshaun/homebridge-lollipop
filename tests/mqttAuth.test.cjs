'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { mqttPassword, createAuthenticatedMqttOptions } = require('../lib/mqttAuth');

let mqtt;
try {
    mqtt = require('mqtt');
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

let directory;
let fixtures;

before(() => {
    // Generate short-lived, entirely synthetic test identities. No private key
    // or vendor credential is checked in, downloaded, or reused by these tests.
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lollipop-mqtt-auth-'));
    const run = args => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
    const root = name => {
        run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
            '-keyout', name + '.key', '-out', name + '.crt', '-days', '1', '-subj', '/CN=' + name,
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    };
    const leaf = (name, ca, purpose, rsa = false) => {
        const args = rsa ? ['-newkey', 'rsa:2048'] : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
        run(['req', '-new', ...args, '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + name]);
        fs.writeFileSync(path.join(directory, name + '.ext'),
            'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n' +
            'extendedKeyUsage=' + purpose + '\n' + (purpose === 'serverAuth' ? 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' : ''));
        run(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.crt', '-CAkey', ca + '.key',
            '-CAcreateserial', '-out', name + '.crt', '-days', '1', '-sha256', '-extfile', name + '.ext']);
    };
    root('test-ca');
    root('other-ca');
    leaf('test-server', 'test-ca', 'serverAuth', true);
    leaf('test-client', 'test-ca', 'clientAuth');
    leaf('other-client', 'other-ca', 'clientAuth');
    const read = name => fs.readFileSync(path.join(directory, name));
    fixtures = {
        ca: read('test-ca.crt'), otherCa: read('other-ca.crt'),
        serverCert: read('test-server.crt'), serverKey: read('test-server.key'),
        cert: read('test-client.crt'), key: read('test-client.key'),
        otherCert: read('other-client.crt'), otherKey: read('other-client.key')
    };
});

after(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function credentials(overrides = {}) {
    return { cameraId: 'synthetic-pairing-id', cert: fixtures.cert, key: fixtures.key, ...overrides };
}

test('MQTT password uses the recovered camera-only MD5 input and keeps leading zeroes', () => {
    assert.equal(mqttPassword('synthetic-pairing-id'), '25696c4c1b836b64532148fad72be804');
    assert.equal(mqttPassword('camera-001'), 'b607c7276252d81bb7efbb5d4bf6fbd1');
    assert.equal(mqttPassword('camera-6'), '0a5359c61d0dd5bdb0b93352749ba4a7');
    assert.notEqual(mqttPassword('synthetic-pairing-id'), '325816c6351dfc0abb3a0cf9c2542c8e', 'The RTSP password must not be reused');
});

test('invalid camera IDs cannot inject MQTT topic separators or wildcards', () => {
    for (const cameraId of [undefined, '', 123, 'bad:id', 'bad/id', 'bad#id', 'bad+id', 'bad id', 'bad\0id', 'x'.repeat(513)]) {
        assert.throws(() => mqttPassword(cameraId), { code: 'MQTT_CAMERA_ID_INVALID' });
    }
});

test('authenticated options include a matching identity and only the recovered private CA', () => {
    const options = createAuthenticatedMqttOptions(credentials());
    assert.equal(options.username, 'lollipop');
    assert.equal(options.password, '25696c4c1b836b64532148fad72be804');
    assert.deepEqual(options.cert, fixtures.cert);
    assert.deepEqual(options.key, fixtures.key);
    assert.equal(crypto.createHash('sha256').update(options.ca).digest('hex'),
        '22baeb6e2d10e9589c39912eee0bd4a3eab5aec8ac4542753c9aaec407157836');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.equal(options.clientId, undefined, 'MQTT.js generates the client ID');
    assert.equal(options.checkServerIdentity('192.0.2.10', {}), undefined);
});

test('an injected alternative CA retains hostname checks rather than widening the app CA exception', () => {
    const options = createAuthenticatedMqttOptions(credentials({ ca: fixtures.ca }));
    assert.equal(options.checkServerIdentity, tls.checkServerIdentity);
    assert.equal(options.checkServerIdentity('192.0.2.10', { subject: { CN: 'unrelated.example' } }).code,
        'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(options.rejectUnauthorized, true);
});

test('mismatched private keys and invalid certificates are rejected before any network connection', () => {
    assert.throws(() => createAuthenticatedMqttOptions(credentials({ key: fixtures.otherKey })),
        { code: 'MQTT_CLIENT_IDENTITY_MISMATCH' });
    assert.throws(() => createAuthenticatedMqttOptions(credentials({ cert: fixtures.key })),
        { code: 'MQTT_CLIENT_CERT_INVALID' });
    assert.throws(() => createAuthenticatedMqttOptions(credentials({ cert: Buffer.from('-----BEGIN CERTIFICATE-----\ncorrupt\n-----END CERTIFICATE-----') })),
        { code: 'MQTT_CLIENT_CERT_INVALID' });
    assert.throws(() => createAuthenticatedMqttOptions(credentials({ key: fixtures.cert })),
        { code: 'MQTT_CLIENT_KEY_INVALID' });
    assert.throws(() => createAuthenticatedMqttOptions(credentials({ ca: fixtures.key })),
        { code: 'MQTT_CA_INVALID' });
});

test('PEM chain certificates, RSA keys, and original CRLF bytes are handled without rewriting credentials', () => {
    const key = Buffer.from(fixtures.serverKey.toString('utf8').replace(/\n/g, '\r\n'));
    const cert = Buffer.concat([fixtures.serverCert, fixtures.ca]);
    const options = createAuthenticatedMqttOptions(credentials({ cert, key }));
    assert.deepEqual(options.cert, cert);
    assert.deepEqual(options.key, key);
});

test('expired and not-yet-valid identities are detected before opening a network connection', () => {
    const originalNow = Date.now;
    const now = originalNow();
    try {
        Date.now = () => now + 2 * 24 * 60 * 60 * 1000;
        assert.throws(() => createAuthenticatedMqttOptions(credentials()), { code: 'MQTT_CLIENT_CERT_EXPIRED' });
        Date.now = () => now - 60 * 60 * 1000;
        assert.throws(() => createAuthenticatedMqttOptions(credentials()), { code: 'MQTT_CLIENT_CERT_NOT_YET_VALID' });
    } finally {
        Date.now = originalNow;
    }
});

test('validation failures contain no certificate URL, private material, or supplied secret', () => {
    const secret = 'private-download-token-123';
    for (const input of [
        credentials({ cert: 'https://example.invalid/' + secret }),
        credentials({ key: '-----BEGIN PRIVATE KEY-----\n' + secret + '\n-----END PRIVATE KEY-----' }),
        credentials({ cameraId: secret + '/#' }),
        credentials({ ca: secret })
    ]) {
        assert.throws(() => createAuthenticatedMqttOptions(input), error => {
            assert.ok(!String(error.stack).includes(secret));
            assert.ok(!JSON.stringify(error).includes(secret));
            return /^MQTT_/.test(error.code);
        });
    }
});

function packet(type, payload) {
    const length = [];
    let remaining = payload.length;
    do {
        let byte = remaining % 128;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) byte |= 128;
        length.push(byte);
    } while (remaining > 0);
    return Buffer.concat([Buffer.from([type, ...length]), payload]);
}

function mqttString(value) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

async function loopbackSession(options) {
    const report = { accepted: false, connected: false, subscribed: false, received: false, clientErrors: [], commands: [] };
    const sockets = new Set();
    const server = tls.createServer({
        cert: fixtures.serverCert, key: fixtures.serverKey, ca: fixtures.ca,
        requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2'
    }, socket => {
        report.accepted = socket.authorized;
        socket.on('error', () => {});
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length > 1) {
                let length = 0;
                let multiplier = 1;
                let offset = 1;
                let byte;
                do {
                    if (offset >= buffer.length) return;
                    byte = buffer[offset++];
                    length += (byte & 127) * multiplier;
                    multiplier *= 128;
                } while (byte & 128);
                if (buffer.length < offset + length) return;
                const type = buffer[0] >> 4;
                const data = buffer.subarray(offset, offset + length);
                buffer = buffer.subarray(offset + length);
                if (type === 1) {
                    let position = 0;
                    const readString = () => {
                        const size = data.readUInt16BE(position);
                        position += 2;
                        const value = data.subarray(position, position + size).toString('utf8');
                        position += size;
                        return value;
                    };
                    readString(); // protocol name
                    position++; // protocol version
                    const flags = data[position++];
                    position += 2; // keepalive
                    readString(); // generated client ID
                    const username = flags & 128 ? readString() : undefined;
                    const password = flags & 64 ? readString() : undefined;
                    // Independent expected digest, not a call back into the helper.
                    const accepted = username === 'lollipop' && password === '25696c4c1b836b64532148fad72be804';
                    report.authenticated = accepted;
                    socket.write(Buffer.from([0x20, 0x02, 0x00, accepted ? 0x00 : 0x04]));
                } else if (type === 8) {
                    socket.write(packet(0x90, Buffer.from([data[0], data[1], 0])));
                    socket.write(packet(0x30, Buffer.concat([mqttString('synthetic-pairing-id/musicStatus/return'),
                        Buffer.from('42["musicStatus",{"result":{"playStatus":"stop"}}]')])));
                } else if (type === 3) {
                    const topicLength = data.readUInt16BE(0);
                    report.commands.push({
                        topic: data.subarray(2, topicLength + 2).toString('utf8'),
                        payload: data.subarray(topicLength + 2).toString('utf8')
                    });
                    finish();
                } else if (type === 12) {
                    socket.write(Buffer.from([0xd0, 0]));
                }
            }
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    let client;
    let timer;
    let settle;
    let finished = false;
    function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (client) client.end(true);
        settle();
    }
    try {
        await new Promise(resolve => {
            settle = resolve;
            timer = setTimeout(() => { report.timeout = true; finish(); }, 4000);
            client = mqtt.connect('mqtts://127.0.0.1:' + server.address().port, {
                ...options, reconnectPeriod: 0, connectTimeout: 3000, queueQoSZero: false
            });
            client.on('error', error => { report.clientErrors.push(error.code); finish(); });
            client.on('close', finish);
            client.on('connect', () => {
                report.connected = true;
                client.subscribe('synthetic-pairing-id/musicStatus/return', (error, granted) => {
                    report.subscribed = !error && granted[0].qos === 0;
                });
            });
            client.on('message', (topic, payload) => {
                report.received = topic === 'synthetic-pairing-id/musicStatus/return' && payload.toString().includes('stop');
                client.publish('synthetic-pairing-id/controlMusic', '{"method":"controlMusic","params":{"playStatus":"play"},"id":17}', { qos: 0 });
            });
        });
    } finally {
        clearTimeout(timer);
        if (client) client.end(true);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
    assert.equal(report.timeout, undefined, 'A test must reach an actual broker result before its safety deadline');
    return report;
}

const integration = { skip: mqtt ? false : 'Install the mqtt runtime dependency to run real TLS/MQTT tests' };

test('real mTLS plus MQTT authentication, subscription, status delivery, and control publish succeed', integration, async () => {
    const options = createAuthenticatedMqttOptions(credentials({ ca: fixtures.ca }));
    const report = await loopbackSession(options);
    assert.equal(report.accepted, true);
    assert.equal(report.authenticated, true);
    assert.equal(report.connected, true);
    assert.equal(report.subscribed, true);
    assert.equal(report.received, true);
    assert.equal(report.commands[0].topic, 'synthetic-pairing-id/controlMusic');
    assert.equal(JSON.parse(report.commands[0].payload).params.playStatus, 'play');
    assert.deepEqual(report.clientErrors, []);
});

test('real mTLS rejects an otherwise matching identity issued by a different CA', integration, async () => {
    const options = createAuthenticatedMqttOptions(credentials({ cert: fixtures.otherCert, key: fixtures.otherKey, ca: fixtures.ca }));
    const report = await loopbackSession(options);
    assert.equal(report.accepted, false);
    assert.equal(report.connected, false);
    assert.equal(report.commands.length, 0);
});

test('app-style hostname policy still rejects a server outside the trusted camera CA', integration, async () => {
    // This keeps the exact production hostname callback and vendor CA. The
    // synthetic server is outside that trust domain and must fail before MQTT.
    const report = await loopbackSession(createAuthenticatedMqttOptions(credentials()));
    assert.equal(report.connected, false);
    assert.equal(report.commands.length, 0);
    assert.ok(report.clientErrors.length > 0);
});

test('real MQTT rejects a wrong camera-derived password after successful mTLS', integration, async () => {
    const options = createAuthenticatedMqttOptions(credentials({ cameraId: 'another-camera', ca: fixtures.ca }));
    const report = await loopbackSession(options);
    assert.equal(report.accepted, true);
    assert.equal(report.authenticated, false);
    assert.equal(report.connected, false);
    assert.equal(report.commands.length, 0);
    assert.ok(report.clientErrors.includes(4));
});

test('real Lollipop and HomeKit sound switch use authenticated MQTT and wait for camera state confirmation', integration, async () => {
    const { createEnvironment } = require('./helpers.cjs');
    const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
    };
    const cameraId = 'synthetic-pairing-id';
    const subscribed = deferred();
    const initialStatus = deferred();
    const failure = deferred();
    const sockets = new Set();
    const commands = [];
    let brokerSocket;
    let brokerState = 'pause';
    let subscription;
    let activeCommand;
    let env;
    let client;
    let deadline;
    let clientEndCalls = 0;
    const sendStatus = status => {
        brokerSocket.write(packet(0x30, Buffer.concat([
            mqttString(cameraId + '/musicStatus/return'),
            Buffer.from('42["musicStatus",' + JSON.stringify({ id: 0, result: { playStatus: status, countdownTimer: 1800 } }) + ']')
        ])));
    };
    const server = tls.createServer({
        cert: fixtures.serverCert, key: fixtures.serverKey, ca: fixtures.ca,
        requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2'
    }, socket => {
        try { assert.equal(socket.authorized, true, 'Broker must verify the client certificate'); }
        catch (error) { failure.reject(error); return; }
        brokerSocket = socket;
        socket.on('error', () => {});
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            try {
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length > 1) {
                    let size = 0;
                    let multiplier = 1;
                    let offset = 1;
                    let byte;
                    do {
                        if (offset >= buffer.length) return;
                        byte = buffer[offset++];
                        size += (byte & 127) * multiplier;
                        multiplier *= 128;
                    } while (byte & 128);
                    if (buffer.length < offset + size) return;
                    const header = buffer[0];
                    const data = buffer.subarray(offset, offset + size);
                    buffer = buffer.subarray(offset + size);
                    let position = 0;
                    const readString = () => {
                        const length = data.readUInt16BE(position);
                        position += 2;
                        const value = data.subarray(position, position + length).toString('utf8');
                        position += length;
                        return value;
                    };
                    if (header >> 4 === 1) {
                        assert.equal(readString(), 'MQTT');
                        assert.equal(data[position++], 4);
                        const flags = data[position++];
                        assert.ok(flags & 128);
                        assert.ok(flags & 64);
                        assert.equal(flags & 4, 0, 'No unexpected MQTT will payload');
                        position += 2;
                        assert.ok(readString(), 'MQTT.js supplies a client ID');
                        assert.equal(readString(), 'lollipop');
                        assert.equal(readString(), '25696c4c1b836b64532148fad72be804');
                        socket.write(Buffer.from([0x20, 2, 0, 0]));
                    } else if (header >> 4 === 8) {
                        const id = data.subarray(0, 2);
                        position = 2;
                        const topics = [];
                        while (position < data.length) {
                            topics.push(readString());
                            assert.equal(data[position++], 0);
                        }
                        subscription = { id, topics };
                        // Deliberately hold SUBACK until the test checks that
                        // HomeKit cannot issue a command before subscription.
                        subscribed.resolve();
                    } else if (header >> 4 === 3) {
                        assert.equal(header & 15, 0, 'Interactive requests must be QoS 0 and not retained');
                        const topic = readString();
                        const body = JSON.parse(data.subarray(position).toString('utf8'));
                        if (topic === cameraId + '/musicStatus') {
                            assert.equal(body.method, 'musicStatus');
                            assert.equal(body.id, 0);
                            sendStatus(brokerState);
                        } else if (topic === cameraId + '/controlMusic') {
                            assert.equal(body.method, 'controlMusic');
                            assert.equal(body.id, 0);
                            assert.ok(activeCommand);
                            assert.equal(body.params.playStatus, activeCommand.desired);
                            assert.equal(body.params.countdownTimer, 1800);
                            if (activeCommand.desired === 'play') assert.equal(body.params.repeatStatus, 'one');
                            commands.push(body);
                            activeCommand.received.resolve();
                            socket.write(packet(0x30, Buffer.concat([
                                mqttString(cameraId + '/controlMusic/return'),
                                Buffer.from('42["controlMusic",{"id":0,"result":{"status":1}}]')
                            ])));
                            // The transport ACK intentionally does not change
                            // brokerState. HomeKit must still await musicStatus.
                        } else {
                            throw new Error('Unexpected MQTT request topic');
                        }
                    } else if (header >> 4 === 12) {
                        socket.write(Buffer.from([0xd0, 0]));
                    }
                }
            } catch (error) { failure.reject(error); }
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', error => failure.reject(error));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const exercise = async () => {
        env = createEnvironment({
            realSoundMachine: true,
            mqttAuth: {
                createAuthenticatedMqttOptions: input => createAuthenticatedMqttOptions({ ...input, ca: fixtures.ca })
            },
            mqtt: {
                connect(url, options) {
                    assert.equal(url, 'mqtts://127.0.0.1:1883');
                    assert.equal(options.rejectUnauthorized, true);
                    assert.equal(options.minVersion, 'TLSv1.2');
                    assert.equal(options.queueQoSZero, false);
                    assert.equal(options.username, 'lollipop');
                    assert.equal(options.password, '25696c4c1b836b64532148fad72be804');
                    // Only replace the broker's port for this loopback test.
                    client = mqtt.connect('mqtts://127.0.0.1:' + server.address().port, options);
                    const end = client.end.bind(client);
                    client.end = (...args) => { clientEndCalls++; return end(...args); };
                    client.on('error', error => failure.reject(error));
                    client.on('message', (topic, payload) => {
                        if (topic === cameraId + '/controlMusic/return' && activeCommand) {
                            activeCommand.acknowledged.resolve();
                        }
                        if (topic === cameraId + '/musicStatus/return') {
                            const text = payload.toString('utf8');
                            const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).result;
                            if (activeCommand && result.playStatus !== activeCommand.desired) activeCommand.oldStatus.resolve();
                            initialStatus.resolve();
                        }
                    });
                    return client;
                }
            }
        });
        const { lollipop } = env.createCamera({
            name: 'Synthetic runtime camera', ip: '127.0.0.1', cameraId, enableSoundMachine: true
        }, { accountConnection: { credentials: { cert: fixtures.cert, key: fixtures.key } } });
        const sound = lollipop.soundMachine;
        const on = sound.accessory.getService(env.Service.Switch).getCharacteristic(env.Characteristic.On);
        await subscribed.promise;
        assert.equal(client.stream.authorized, true, 'Client must verify the synthetic camera CA');
        assert.equal(sound.isConnected(), false);
        let earlyError;
        on.emit('set', true, error => { earlyError = error; });
        assert.ok(earlyError, 'A HomeKit write before SUBACK must fail immediately');
        assert.equal(commands.length, 0);
        assert.deepEqual(subscription.topics, [
            'liveNote', 'prenotify', 'cameraStatus/return', 'musicStatus/return', 'controlMusic/return'
        ].map(topic => cameraId + '/' + topic));
        brokerSocket.write(packet(0x90, Buffer.concat([subscription.id, Buffer.from(subscription.topics.map(() => 0))])));
        await initialStatus.promise;
        assert.equal(sound.isConnected(), true);
        assert.equal(on.value, false);

        for (const desired of ['play', 'pause']) {
            const phase = {
                desired, received: deferred(), acknowledged: deferred(), oldStatus: deferred(),
                completed: deferred(), callbackCalls: 0
            };
            activeCommand = phase;
            on.emit('set', desired === 'play', error => {
                phase.callbackCalls++;
                phase.completed.resolve(error);
            });
            await phase.received.promise;
            await phase.acknowledged.promise;
            await phase.oldStatus.promise;
            assert.equal(phase.callbackCalls, 0, 'A write or control ACK must not report unconfirmed camera state');
            brokerState = desired;
            sendStatus(brokerState);
            assert.equal(await phase.completed.promise, null);
            assert.equal(phase.callbackCalls, 1);
            assert.equal(on.value, desired === 'play');
            activeCommand = undefined;
        }

        assert.deepEqual(commands.map(command => command.params.playStatus), ['play', 'pause']);
        assert.equal(env.state.logs.filter(entry => entry.level === 'error').length, 0);
        const ended = new Promise(resolve => client.once('end', resolve));
        env.api.emit('shutdown');
        await ended;
        assert.equal(lollipop.stopped, true);
        assert.equal(sound.stopped, true);
        assert.equal(client.connected, false);
        assert.equal(clientEndCalls, 1);
        assert.equal(env.state.timers.size, 0);
    };
    try {
        deadline = setTimeout(() => failure.reject(new Error('Runtime TLS/MQTT integration timed out')), 7000);
        await Promise.race([exercise(), failure.promise]);
    } finally {
        clearTimeout(deadline);
        if (env) env.api.emit('shutdown');
        if (client && !client.disconnecting) client.end(true);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});
