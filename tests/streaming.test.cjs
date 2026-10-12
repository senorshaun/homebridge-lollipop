const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

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
    const context = {
        module,
        exports: module.exports,
        require(id) {
            return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : require(id);
        },
        Buffer,
        process,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
    return module.exports;
}

function processFixture({ withCallback = true } = {}) {
    const timers = fakeTimers();
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
    const callbacks = [];
    const stopped = [];
    const forced = [];
    const logs = [];
    const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, message => logs.push({ level, message })]));
    const delegate = {
        stopStream: id => stopped.push(id),
        controller: { forceStopStreamingSession: id => forced.push(id) }
    };
    const spawned = [];
    const { FfmpegProcess } = loadModule('lib/ffmpeg.js', {
        child_process: { spawn: (executable, args) => { spawned.push({ executable, args }); return child; } }
    }, timers);
    const ffmpeg = new FfmpegProcess(
        'Test camera', 'test-session', '/test/ffmpeg',
        '-rtsp_transport tcp -i rtsp://user:synthetic%20token@192.0.2.10/live/camera -progress pipe:1',
        log, false, delegate, withCallback ? error => callbacks.push(error) : undefined
    );
    function exit(code = 0, signal = null, closeOnly = false) {
        child.stdout.end();
        child.stderr.end();
        if (!closeOnly) child.emit('exit', code, signal);
        child.emit('close', code, signal);
    }
    return { ffmpeg, child, callbacks, stopped, forced, logs, timers, spawned, exit };
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

function streamingFixture() {
    const timers = fakeTimers();
    const events = new Map();
    const api = {
        on: (event, callback) => events.set(event, callback),
        hap: { CameraController: class {} }
    };
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const { StreamingDelegate } = loadModule('lib/streamingDelegate.js', {
        'ffmpeg-for-homebridge': '/test/ffmpeg',
        'pick-port': async () => 30000,
        './ffmpeg': {},
        './recordingDelegate': { PREBUFFER_LENGTH: 4000, FRAGMENTS_LENGTH: 4000 }
    }, timers);
    const delegate = new StreamingDelegate(log, { hksv: false }, api, { displayName: 'Test camera' });
    return { delegate, events, timers };
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
