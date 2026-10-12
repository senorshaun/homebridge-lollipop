const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { Logger } = require('../lib/logger');
const { allocateStreamReference } = require('../lib/ffmpeg');

const root = path.resolve(__dirname, '..');

function fakeTimers() {
    let nextId = 1;
    const pending = new Map();
    return {
        pending,
        setTimeout(callback, delay) {
            const id = nextId++;
            pending.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        fire(delay) {
            const entry = [...pending].find(([, timer]) => timer.delay === delay);
            assert.ok(entry, `Expected a pending ${delay} ms timer`);
            pending.delete(entry[0]);
            entry[1].callback();
        }
    };
}

function loadModule(relativePath, overrides, timers) {
    const module = { exports: {} };
    const localRequire = createRequire(path.join(root, relativePath));
    const context = {
        module,
        exports: module.exports,
        require(id) {
            return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : localRequire(id);
        },
        Buffer,
        process,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
    return module.exports;
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.signals = [];
    child.kill = signal => {
        child.signals.push(signal);
        child.killed = true;
        return true;
    };
    return child;
}

function testLogger(logs, enabled, realLogger) {
    const sink = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, message => logs.push({ level, message })]));
    return realLogger ? new Logger(sink, enabled) : sink;
}

function processFixture({ withCallback = true, debug = false, globalDebug = false, realLogger = false, diagnosticThrows = false } = {}) {
    const timers = fakeTimers();
    const child = fakeChild();
    const callbacks = [];
    const stopped = [];
    const forced = [];
    const logs = [];
    const log = testLogger(logs, debug || globalDebug, realLogger);
    if (diagnosticThrows) log.diagnostic = () => { throw new Error('Synthetic logging failure'); };
    const delegate = {
        config: { diagnosticRef: 'camera-1', audio: false },
        stopStream: id => stopped.push(id),
        controller: { forceStopStreamingSession: id => forced.push(id) }
    };
    const spawned = [];
    const { FfmpegProcess } = loadModule('lib/ffmpeg.js', {
        child_process: { spawn: (executable, args) => { spawned.push({ executable, args }); return child; } }
    }, timers);
    const ffmpeg = new FfmpegProcess(
        'Test camera', 'test-session', '/test/ffmpeg',
        '-rtsp_transport tcp -i rtsp://user:synthetic%20token@192.0.2.10/live/camera -srtp_out_params SYNTHETIC-SRTP-KEY -progress pipe:1',
        log, debug, delegate, withCallback ? error => callbacks.push(error) : undefined
    );
    function exit(code = 0, signal = null, closeOnly = false) {
        child.stdout.end();
        child.stderr.end();
        if (!closeOnly) child.emit('exit', code, signal);
        child.emit('close', code, signal);
    }
    return { ffmpeg, child, callbacks, stopped, forced, logs, timers, spawned, exit, log };
}

test('FFmpeg authentication rejection reports one startup failure, never success from stderr', () => {
    const f = processFixture();
    f.child.stderr.write('ffmpeg version test\n[rtsp] method DESCRIBE failed: 401 Unauthorized\n');
    assert.equal(f.callbacks.length, 0);
    f.exit(1);
    assert.equal(f.callbacks.length, 1);
    assert.match(f.callbacks[0].message, /authentication was rejected/);
    assert.deepEqual(f.stopped, ['test-session']);
    assert.deepEqual(f.forced, []);
    assert.equal(f.timers.pending.size, 0);
});

test('first positive frame acknowledges startup once across split stdout chunks', () => {
    const f = processFixture();
    f.child.stderr.write('Input opened; this is not proof of decoded video\n');
    f.child.stdout.write('fra');
    f.child.stdout.write('me=0\r\nprogress=continue\nfr');
    assert.equal(f.callbacks.length, 0);
    f.child.stdout.write('ame=1\r\nprogress=continue\nframe=2\nprogress=continue\n');
    assert.deepEqual(f.callbacks, [undefined]);
    assert.equal(f.timers.pending.size, 0);
    assert.ok(f.spawned[0].args.includes('rtsp://user:synthetic%20token@192.0.2.10/live/camera'));
    f.ffmpeg.stop();
    f.exit(255, 'SIGTERM');
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.timers.pending.size, 0);
});

test('startup without video times out and stops FFmpeg with bounded kill escalation', () => {
    const f = processFixture();
    f.child.stderr.write('Waiting for camera packets\n');
    f.timers.fire(20000);
    assert.equal(f.callbacks.length, 1);
    assert.match(f.callbacks[0].message, /within 20 seconds/);
    assert.deepEqual(f.stopped, ['test-session']);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    f.child.stdout.write('frame=1\nprogress=continue\n');
    assert.equal(f.callbacks.length, 1, 'Late frames must not acknowledge an already failed start');
    f.timers.fire(2000);
    assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
    f.exit(null, 'SIGKILL');
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.timers.pending.size, 0);
});

test('spawn error followed by close without exit settles callback and cleans up once', () => {
    const f = processFixture();
    f.child.emit('error', new Error('spawn /test/ffmpeg ENOENT'));
    f.exit(-2, null, true);
    assert.equal(f.callbacks.length, 1);
    assert.match(f.callbacks[0].message, /ENOENT/);
    assert.deepEqual(f.stopped, ['test-session']);
    assert.equal(f.timers.pending.size, 0);
});

test('unexpected clean, forced-code, and signal exits before video all fail startup', () => {
    for (const [code, signal] of [[0, null], [255, null], [null, 'SIGSEGV']]) {
        const f = processFixture();
        f.exit(code, signal);
        assert.equal(f.callbacks.length, 1);
        assert.match(f.callbacks[0].message, /FFmpeg exited/);
        assert.deepEqual(f.stopped, ['test-session']);
        assert.equal(f.timers.pending.size, 0);
    }
});

test('exit after first video frame stops the HomeKit session without a second start callback', () => {
    const f = processFixture();
    f.child.stdout.write('frame=1\nprogress=continue\n');
    f.exit(1);
    assert.deepEqual(f.callbacks, [undefined]);
    assert.deepEqual(f.stopped, ['test-session']);
    assert.deepEqual(f.forced, ['test-session']);
    assert.equal(f.timers.pending.size, 0);
});

test('canceling startup clears its deadline and remains idempotent on process exit', () => {
    const f = processFixture();
    f.ffmpeg.stop();
    f.ffmpeg.stop();
    assert.equal(f.callbacks.length, 1);
    assert.match(f.callbacks[0].message, /stopped before/);
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.equal([...f.timers.pending.values()].some(timer => timer.delay === 20000), false);
    f.child.stdout.write('frame=5\nprogress=end\n');
    f.exit(255, 'SIGTERM');
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.timers.pending.size, 0);
});

test('return-audio process has no video startup deadline and its failure stops the session', () => {
    const f = processFixture({ withCallback: false });
    assert.equal(f.timers.pending.size, 0);
    f.exit(1);
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(f.stopped, ['test-session']);
    assert.deepEqual(f.forced, ['test-session']);
});

function streamingFixture({ config = {}, globalDebug = false, realLogger = false, pickPort, bindError, processError,
    processErrorAt = 1, reentrantStop = false } = {}) {
    const timers = fakeTimers();
    const events = new Map();
    const api = {
        on: (event, callback) => events.set(event, callback),
        hap: { CameraController: class { static generateSynchronisationSource() { return 12345; } forceStopStreamingSession() {} } }
    };
    const logs = [];
    const log = testLogger(logs, config.debug === true || globalDebug, realLogger);
    const spawned = [];
    const processes = [];
    let processAttempts = 0;
    const sockets = [];
    const { StreamingDelegate } = loadModule('lib/streamingDelegate.js', {
        child_process: { spawn(executable, args) {
            const child = fakeChild();
            spawned.push({ executable, args, child });
            return child;
        } },
        dgram: { createSocket() {
            const socket = new EventEmitter();
            socket.bind = port => { if (bindError) throw bindError; socket.boundPort = port; };
            socket.close = () => { socket.closed = true; };
            sockets.push(socket);
            return socket;
        } },
        'ffmpeg-for-homebridge': '/test/ffmpeg',
        'pick-port': pickPort || (async () => 30000),
        './ffmpeg': { allocateStreamReference, FfmpegProcess: class {
            constructor(...args) {
                if (processError && ++processAttempts === processErrorAt) throw processError;
                this.args = args; this.stdin = new PassThrough(); processes.push(this);
            }
            stop() {
                this.stopped = true;
                if (reentrantStop && typeof this.args[7] === 'function') this.args[7](new Error('Synthetic startup cancellation'));
            }
        } },
        './recordingDelegate': { PREBUFFER_LENGTH: 4000, FRAGMENTS_LENGTH: 4000 }
    }, timers);
    const delegate = new StreamingDelegate(log, { hksv: false, diagnosticRef: 'camera-1',
        source: '-rtsp_transport tcp -i rtsp://user:synthetic%20token@192.0.2.10/live/camera', ...config }, api, { displayName: 'Test camera' });
    return { delegate, events, timers, logs, log, spawned, processes, sockets };
}

test('Homebridge shutdown stops every active session in the Map and clears prepared sessions', () => {
    const f = streamingFixture();
    const closed = [];
    const stopped = [];
    for (const id of ['one', 'two']) {
        f.delegate.ongoingSessions.set(id, {
            socket: { close: () => closed.push(id) },
            mainProcess: { stop: () => stopped.push(id + ':video') },
            returnProcess: { stop: () => stopped.push(id + ':audio') },
            timeout: f.timers.setTimeout(() => {}, 1000)
        });
    }
    f.delegate.pendingSessions.set('prepared', {});
    f.events.get('shutdown')();
    assert.deepEqual(closed, ['one', 'two']);
    assert.deepEqual(stopped, ['one:video', 'one:audio', 'two:video', 'two:audio']);
    assert.equal(f.delegate.ongoingSessions.size, 0);
    assert.equal(f.delegate.pendingSessions.size, 0);
    assert.equal(f.timers.pending.size, 0);
});

test('stopping a prepared session removes it before it can start later', () => {
    const f = streamingFixture();
    f.delegate.pendingSessions.set('prepared', {});
    f.delegate.stopStream('prepared');
    assert.equal(f.delegate.pendingSessions.size, 0);
});

test('session teardown removes ownership before a startup callback can request another stop', () => {
    const f = streamingFixture();
    let socketCloseCount = 0;
    let processStopCount = 0;
    f.delegate.ongoingSessions.set('starting', {
        socket: { close: () => { socketCloseCount++; } },
        mainProcess: {
            stop: () => {
                processStopCount++;
                f.delegate.stopStream('starting');
            }
        }
    });
    f.delegate.stopStream('starting');
    assert.equal(socketCloseCount, 1);
    assert.equal(processStopCount, 1);
    assert.equal(f.delegate.ongoingSessions.size, 0);
});

const diagnosticText = fixture => fixture.logs.filter(record => record.message.includes('[diagnostic')).map(record => record.message).join('\n');

test('FFmpeg diagnostics correlate process start, first frame, stop, signals and exit without connection secrets', () => {
    const f = processFixture({ globalDebug: true, realLogger: true });
    f.child.emit('spawn');
    f.child.stderr.write('Opening rtsp://user:synthetic%20token@192.0.2.10/live/camera\n');
    f.child.stdout.write('frame=1\nframe=2\n');
    f.ffmpeg.stop();
    f.exit(255, 'SIGTERM');
    const diagnostics = diagnosticText(f);
    assert.match(diagnostics, /media\.stream.*phase=start.*streamRef=stream-\d+/);
    assert.match(diagnostics, /phase=first_frame.*frames=1/);
    assert.equal((diagnostics.match(/phase=first_frame/g) || []).length, 1);
    assert.match(diagnostics, /phase=signal.*signal=SIGTERM/);
    assert.match(diagnostics, /phase=exit.*exitCode=255.*signal=SIGTERM/);
    assert.match(diagnostics, /cameraRef=camera-1/);
    assert.equal(new Set([...diagnostics.matchAll(/streamRef=(stream-\d+)/g)].map(match => match[1])).size, 1);
    const messages = f.logs.map(record => record.message).join('\n');
    assert.doesNotMatch(messages, /test-session|synthetic%20token|synthetic token|192\.0\.2\.10|SYNTHETIC-SRTP-KEY/);
    assert.match(messages, /Opening \[redacted camera URL\]/, 'Global debug should include redacted FFmpeg stderr');
    assert.deepEqual(f.callbacks, [undefined]);
});

test('FFmpeg debug off suppresses diagnostics and stderr, and optional diagnostic errors cannot change startup', () => {
    const off = processFixture({ realLogger: true });
    off.child.stderr.write('SYNTHETIC-STDERR-MARKER\n');
    off.child.stdout.write('frame=1\n');
    off.ffmpeg.stop();
    off.exit(255, 'SIGTERM');
    assert.equal(diagnosticText(off), '');
    assert.doesNotMatch(off.logs.map(record => record.message).join('\n'), /SYNTHETIC-STDERR-MARKER/);

    const throwing = processFixture({ diagnosticThrows: true });
    throwing.child.emit('spawn');
    throwing.child.stdout.write('frame=1\n');
    throwing.ffmpeg.stop();
    throwing.exit(255, 'SIGTERM');
    assert.deepEqual(throwing.callbacks, [undefined]);
    assert.equal(throwing.timers.pending.size, 0);
});

test('FFmpeg diagnostics distinguish authentication, spawn and startup timeout failures', () => {
    const auth = processFixture({ debug: true, realLogger: true });
    auth.child.stderr.write('[rtsp] 401 Unauthorized\n');
    auth.exit(1);
    assert.match(diagnosticText(auth), /phase=failed.*reason=rtsp_authentication/);
    assert.equal(auth.callbacks.length, 1);

    const spawn = processFixture({ debug: true, realLogger: true });
    spawn.child.emit('error', Object.assign(new Error('FFmpeg not found'), { code: 'ENOENT' }));
    spawn.exit(-2, null, true);
    assert.match(diagnosticText(spawn), /phase=failed.*reason=spawn_error.*errorCode=ENOENT/);

    const timeout = processFixture({ debug: true, realLogger: true });
    timeout.timers.fire(20000);
    timeout.timers.fire(2000);
    timeout.exit(null, 'SIGKILL');
    assert.match(diagnosticText(timeout), /phase=timeout.*reason=startup_timeout/);
    assert.match(diagnosticText(timeout), /phase=signal.*signal=SIGKILL/);
    assert.equal(timeout.callbacks.length, 1);
});

function streamRequest(sessionID = 'private-homekit-session-uuid') {
    return {
        sessionID, type: 'start', addressVersion: 'ipv4', targetAddress: '192.0.2.90',
        video: { port: 45000, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2),
            width: 1280, height: 720, fps: 30, max_bit_rate: 300, pt: 99, rtcp_interval: 0.5 },
        audio: { port: 45002, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4),
            codec: 'AAC-eld', sample_rate: 16, max_bit_rate: 24, channel: 1, pt: 110 }
    };
}

test('stream preparation, selected media settings and RTCP timeout share a generated alias', async () => {
    const f = streamingFixture({ config: { audio: true, maxWidth: 640, maxHeight: 480 }, globalDebug: true, realLogger: true });
    const request = streamRequest();
    let prepared;
    await f.delegate.prepareStream(request, (error, response) => { assert.equal(error, undefined); prepared = response; });
    await f.delegate.startStream(request, () => {});
    assert.equal(prepared.video.port, 30000);
    assert.equal(f.processes.length, 1);
    assert.match(f.processes[0].args[3], /-loglevel level\+verbose/, 'Global debug must activate the existing verbose setting');
    f.sockets[0].emit('message', Buffer.from('private-rtcp-payload'));
    f.timers.fire(2500);
    const diagnostics = diagnosticText(f);
    assert.match(diagnostics, /phase=start.*stage=prepare/);
    assert.match(diagnostics, /phase=selected.*width=640.*height=480.*audio=true/);
    assert.match(diagnostics, /phase=timeout.*reason=rtcp_timeout/);
    assert.match(diagnostics, /phase=cancelled.*requestType=stop/);
    assert.equal(new Set([...diagnostics.matchAll(/streamRef=(stream-\d+)/g)].map(match => match[1])).size, 1);
    assert.doesNotMatch(f.logs.map(record => record.message).join('\n'), /private-homekit-session-uuid|192\.0\.2\.90|private-rtcp-payload/);
    assert.equal(f.delegate.streamReferences.size, 0);
    assert.equal(f.delegate.ongoingSessions.size, 0);
});

test('failed local port reservation calls HomeKit back once, records its safe error and discards the diagnostic alias', async () => {
    const error = Object.assign(new Error('private port-selection details'), { code: 'EADDRINUSE' });
    const f = streamingFixture({ globalDebug: true, realLogger: true, pickPort: async () => { throw error; } });
    const callbacks = [];
    await f.delegate.prepareStream(streamRequest(), failure => callbacks.push(failure));
    assert.deepEqual(callbacks, [error]);
    assert.match(diagnosticText(f), /phase=failed.*stage=prepare.*errorCode=EADDRINUSE/);
    assert.doesNotMatch(diagnosticText(f), /private port-selection details|private-homekit/);
    assert.equal(f.delegate.streamReferences.size, 0);
    assert.equal(f.delegate.pendingSessions.size, 0);
});

test('HomeKit start reports socket and FFmpeg setup exceptions without leaking a session', async () => {
    for (const failure of ['bindError', 'processError']) {
        const error = Object.assign(new Error('Synthetic stream setup failure'), { code: 'EACCES' });
        const f = streamingFixture({ [failure]: error });
        const request = streamRequest();
        await f.delegate.prepareStream(request, setupError => assert.equal(setupError, undefined));
        const callbacks = [];
        f.delegate.handleStreamRequest(request, startError => callbacks.push(startError));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(callbacks, [error]);
        assert.equal(f.sockets[0].closed, true);
        assert.equal(f.delegate.pendingSessions.size, 0);
        assert.equal(f.delegate.ongoingSessions.size, 0);
        assert.equal(f.delegate.streamReferences.size, 0);
        assert.equal(f.timers.pending.size, 0);
    }
});

test('stopping while ports are being reserved cannot resurrect a prepared stream', async () => {
    let reserve;
    let reservations = 0;
    const f = streamingFixture({ pickPort: () => {
        if (++reservations === 1) return new Promise(resolve => { reserve = resolve; });
        return Promise.resolve(30002);
    } });
    const request = streamRequest();
    const callbacks = [];
    const preparing = f.delegate.prepareStream(request, error => callbacks.push(error));
    f.delegate.stopStream(request.sessionID);
    reserve(30000);
    await preparing;
    assert.equal(callbacks.length, 1);
    assert.match(callbacks[0].message, /cancelled/);
    assert.equal(f.delegate.pendingSessions.size, 0);
    assert.equal(f.delegate.streamReferences.size, 0);
});

test('partial stream setup failure settles once when HomeKit and FFmpeg reenter teardown', async () => {
    const error = Object.assign(new Error('Synthetic return-audio spawn failure'), { code: 'ENOENT' });
    const f = streamingFixture({ config: { returnAudioTarget: '-f null -' }, processError: error,
        processErrorAt: 2, reentrantStop: true });
    const request = streamRequest();
    await f.delegate.prepareStream(request, setupError => assert.equal(setupError, undefined));
    const callbacks = [];
    f.delegate.handleStreamRequest(request, startError => {
        callbacks.push(startError);
        f.delegate.stopStream(request.sessionID);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(callbacks, [error]);
    assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].stopped, true);
    assert.equal(f.sockets[0].closed, true);
    assert.equal(f.delegate.pendingSessions.size, 0);
    assert.equal(f.delegate.ongoingSessions.size, 0);
    assert.equal(f.delegate.streamReferences.size, 0);
});

function closeSnapshot(child, output, code = 0) {
    if (output) child.stdout.write(output);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('snapshot diagnostics cover fetch, resize and cache reuse without logging image bytes', async () => {
    const f = streamingFixture({ globalDebug: true, realLogger: true });
    const images = [];
    const first = f.delegate.handleSnapshotRequest({ width: 320, height: 240 }, (error, image) => {
        assert.equal(error, undefined); images.push(image);
    });
    assert.equal(f.spawned.length, 1);
    closeSnapshot(f.spawned[0].child, Buffer.from('PRIVATE-RAW-IMAGE'));
    await settle();
    assert.equal(f.spawned.length, 2);
    closeSnapshot(f.spawned[1].child, Buffer.from('PRIVATE-RESIZED-IMAGE'));
    await first;
    const second = f.delegate.handleSnapshotRequest({ width: 160, height: 120 }, (error, image) => {
        assert.equal(error, undefined); images.push(image);
    });
    await settle();
    assert.equal(f.spawned.length, 3, 'A cache hit must only start the resize process');
    closeSnapshot(f.spawned[2].child, Buffer.from('PRIVATE-SECOND-IMAGE'));
    await second;
    const diagnostics = diagnosticText(f);
    assert.match(diagnostics, /media\.snapshot.*phase=miss.*stage=fetch.*cached=false/);
    assert.match(diagnostics, /phase=complete.*stage=fetch.*bytes=17/);
    assert.match(diagnostics, /phase=complete.*stage=resize/);
    assert.match(diagnostics, /phase=hit.*stage=fetch.*cached=true/);
    assert.match(diagnostics, /phase=complete.*stage=request.*width=160.*height=120/);
    assert.equal(images.length, 2);
    assert.doesNotMatch(f.logs.map(record => record.message).join('\n'), /PRIVATE-RAW-IMAGE|PRIVATE-RESIZED-IMAGE|PRIVATE-SECOND-IMAGE|synthetic%20token/);
    f.timers.fire(3000);
    assert.equal(f.delegate.snapshotPromise, undefined);
});

test('snapshot errors redact complete stderr lines assembled across chunks and keep diagnostics off when disabled', async () => {
    for (const debug of [true, false]) {
        const f = streamingFixture({ config: { debug }, realLogger: true });
        let failure;
        const request = f.delegate.handleSnapshotRequest({ width: 320, height: 240 }, error => { failure = error; });
        const child = f.spawned[0].child;
        child.stderr.write('Failed opening rtsp://user:synthetic%20');
        child.stderr.write('token@192.0.2.10/live/camera: 401 Unauthorized\n');
        closeSnapshot(child, null, 1);
        await request;
        assert.match(failure, /Failed to fetch snapshot/);
        const text = f.logs.map(record => record.message).join('\n');
        assert.doesNotMatch(text, /synthetic%20|token@192\.0\.2|rtsp:\/\//);
        if (debug) {
            assert.match(text, /Failed opening \[redacted camera URL\]/);
            assert.match(diagnosticText(f), /phase=failed.*stage=fetch.*reason=rtsp_authentication/);
        } else {
            assert.equal(diagnosticText(f), '');
            assert.doesNotMatch(text, /Failed opening/);
        }
        f.timers.fire(3000);
    }
});

test('snapshot resize failures are diagnosed without changing the existing callback behavior', async () => {
    const f = streamingFixture({ globalDebug: true, realLogger: true });
    const pending = f.delegate.resizeSnapshot(Buffer.from('PRIVATE-IMAGE'), '');
    closeSnapshot(f.spawned[0].child, null, 1);
    assert.equal((await pending).length, 0);
    assert.match(diagnosticText(f), /phase=failed.*stage=resize.*reason=empty_snapshot.*bytes=0/);

    const spawnFailure = f.delegate.resizeSnapshot(Buffer.from('PRIVATE-IMAGE'), '');
    const child = f.spawned[1].child;
    child.emit('error', Object.assign(new Error('not installed'), { code: 'ENOENT' }));
    closeSnapshot(child, null, -2);
    await assert.rejects(spawnFailure, message => /process creation failed/.test(message));
    assert.match(diagnosticText(f), /phase=failed.*stage=resize.*reason=spawn_error.*errorCode=ENOENT/);
    assert.doesNotMatch(diagnosticText(f), /PRIVATE-IMAGE/);
});
