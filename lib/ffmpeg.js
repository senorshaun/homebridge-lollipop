"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FfmpegProcess = void 0;
const child_process_1 = require("child_process");
const readline_1 = __importDefault(require("readline"));
const { URL } = require('url');
const { emitDiagnostic } = require('./diagnostics');
const STARTUP_TIMEOUT_MS = 20 * 1000;
let nextStreamReference = 0;
function allocateStreamReference() {
    return 'stream-' + (++nextStreamReference);
}
function registerMediaSecrets(log, sessionId, ffmpegArgs) {
    try {
        if (!log || typeof log.addSecrets !== 'function') return;
        const values = [sessionId];
        for (const match of ffmpegArgs.matchAll(/\b(?:rtsps?|https?|mqtts?|srtp):\/\/\S+/gi)) {
            values.push(match[0]);
            try {
                const url = new URL(match[0]);
                values.push(url.hostname, decodeURIComponent(url.username), decodeURIComponent(url.password));
            } catch (_) { /* Full URLs are also removed by the shared logger. */ }
        }
        for (const match of ffmpegArgs.matchAll(/-srtp_out_params\s+(\S+)/g)) values.push(match[1]);
        log.addSecrets(values);
    } catch (_) { /* Diagnostic preparation must not stop a stream. */ }
}
class FfmpegProcess {
    constructor(cameraName, sessionId, videoProcessor, ffmpegArgs, log, debug = false, delegate, callback, requestStartedAt) {
        debug = debug === true || Boolean(log && log.debugMode === true);
        registerMediaSecrets(log, sessionId, ffmpegArgs);
        log.debug('Stream command: ' + videoProcessor + ' ' + ffmpegArgs, cameraName, debug);
        this.started = false;
        this.stopping = false;
        this.exited = false;
        this.failed = false;
        this.startupCallback = callback;
        const hasStartupCallback = typeof callback === 'function';
        let authenticationRejected = false;
        const startTime = Date.now();
        let streamRef;
        try {
            if (delegate && typeof delegate.getStreamReference === 'function') streamRef = delegate.getStreamReference(sessionId);
        } catch (_) { /* An optional correlation label cannot affect streaming. */ }
        this.streamRef = streamRef || allocateStreamReference();
        this.trace = fields => emitDiagnostic(log, 'media.stream', {
            cameraRef: delegate && delegate.config && delegate.config.diagnosticRef,
            streamRef: this.streamRef,
            stage: 'process',
            returnAudio: !hasStartupCallback,
            durationMs: Date.now() - startTime,
            // Elapsed from START, not the earlier HomeKit PREPARE request or screen tap.
            requestAgeMs: Number.isFinite(requestStartedAt)
                ? Math.max(0, Date.now() - requestStartedAt) : undefined,
            ...fields
        }, cameraName);
        this.trace({ phase: 'requested' });
        try {
            this.process = (0, child_process_1.spawn)(videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
        } catch (error) {
            this.trace({ phase: 'failed', reason: 'spawn_error', errorCode: error && error.code });
            throw error;
        }
        this.process.on('spawn', () => this.trace({ phase: 'start' }));
        this.stdin = this.process.stdin;
        const fail = (message, reason, fields = {}) => {
            if (this.failed || this.stopping) {
                return;
            }
            this.failed = true;
            this.trace({ phase: 'failed', reason, active: this.started, ...fields });
            log.error(message, cameraName);
            this.finishStartup(new Error(message));
            this.stop();
            delegate.stopStream(sessionId);
            if (this.started || !hasStartupCallback) {
                delegate.controller.forceStopStreamingSession(sessionId);
            }
        };
        // Progress lines can span stdout chunks. FFmpeg's banner and error output
        // on stderr do not establish that a camera frame was received.
        const stdout = readline_1.default.createInterface({
            input: this.process.stdout,
            terminal: false
        });
        stdout.on('line', (line) => {
            const frame = /^frame=\s*(\d+)\s*$/.exec(line);
            if (!this.started && !this.stopping && !this.failed && !this.exited && frame && Number(frame[1]) > 0) {
                this.started = true;
                this.trace({ phase: 'first_frame', frames: Number(frame[1]) });
                this.finishStartup();
                const runtime = (Date.now() - startTime) / 1000;
                const message = 'Getting the first frames took ' + runtime + ' seconds.';
                if (runtime < 5) {
                    log.debug(message, cameraName, debug);
                }
                else {
                    log.warn(message, cameraName);
                }
            }
        });
        const stderr = readline_1.default.createInterface({
            input: this.process.stderr,
            terminal: false
        });
        let inputMetadataReported = false;
        stderr.on('line', (line) => {
            // This banner follows input probing; it is not a handshake or a video frame.
            // Inspect only the fixed prefix. Never include the source URL in this event.
            if (debug && !inputMetadataReported && !this.stopping && !this.failed && !this.exited &&
                /^(?:\[info\]\s*)?Input #0,\s*rtsp,/.test(line)) {
                inputMetadataReported = true;
                this.trace({ phase: 'received', stage: 'input_metadata' });
            }
            if (!this.started && /401\s+Unauthorized|403\s+Forbidden|authentication failed|authorization failed/i.test(line)) {
                authenticationRejected = true;
            }
            if (debug && line.match(/\[(panic|fatal|error)\]/)) {
                log.error(line, cameraName);
            }
            else if (debug) {
                log.debug(line, cameraName, true);
            }
        });
        this.process.on('error', (error) => {
            fail('FFmpeg process failed: ' + error.message, 'spawn_error', { errorCode: error.code });
        });
        const onExit = (code, signal) => {
            if (this.exited) {
                return;
            }
            this.exited = true;
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
                this.killTimeout = undefined;
            }
            const message = 'FFmpeg exited with code: ' + code + ' and signal: ' + signal;
            this.trace({ phase: 'exit', exitCode: code, signal: signal || 'none', active: this.started,
                reason: this.stopping ? 'stop' : 'ffmpeg_exit' });
            if (this.stopping) {
                log.debug(message + ' (Expected)', cameraName, debug);
            }
            else {
                fail((!this.started && authenticationRejected ? 'Camera authentication was rejected. ' : '') + message,
                    !this.started && authenticationRejected ? 'rtsp_authentication' : 'ffmpeg_exit');
            }
        };
        this.process.on('exit', onExit);
        // A failed spawn can emit error and close without an exit event.
        this.process.on('close', onExit);
        if (typeof this.startupCallback === 'function') {
            this.startupTimeout = setTimeout(() => {
                const reason = authenticationRejected ? 'rtsp_authentication' : 'startup_timeout';
                this.trace({ phase: 'timeout', reason });
                fail(authenticationRejected
                    ? 'Camera authentication was rejected before a video frame was received.'
                    : 'FFmpeg did not produce a video frame within 20 seconds. Check the stream URL and camera reachability.', reason);
            }, STARTUP_TIMEOUT_MS);
        }
    }
    finishStartup(error) {
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = undefined;
        }
        if (typeof this.startupCallback === 'function') {
            const callback = this.startupCallback;
            this.startupCallback = undefined;
            callback(error);
        }
    }
    stop() {
        if (this.stopping || this.exited) {
            return;
        }
        this.stopping = true;
        this.trace({ phase: 'requested', reason: 'stop', active: this.started });
        this.finishStartup(new Error('FFmpeg stopped before receiving a video frame.'));
        this.trace({ phase: 'signal', signal: 'SIGTERM', reason: 'stop' });
        this.process.kill('SIGTERM');
        if (!this.exited) {
            this.killTimeout = setTimeout(() => {
                if (!this.exited) {
                    this.trace({ phase: 'signal', signal: 'SIGKILL', reason: 'stop' });
                    this.process.kill('SIGKILL');
                }
            }, 2 * 1000);
        }
    }
}
exports.FfmpegProcess = FfmpegProcess;
exports.allocateStreamReference = allocateStreamReference;
//# sourceMappingURL=ffmpeg.js.map
