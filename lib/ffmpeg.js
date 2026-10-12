"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FfmpegProcess = void 0;
const child_process_1 = require("child_process");
const readline_1 = __importDefault(require("readline"));
const STARTUP_TIMEOUT_MS = 20 * 1000;
class FfmpegProcess {
    constructor(cameraName, sessionId, videoProcessor, ffmpegArgs, log, debug = false, delegate, callback) {
        log.debug('Stream command: ' + videoProcessor + ' ' + ffmpegArgs, cameraName, debug);
        this.started = false;
        this.stopping = false;
        this.exited = false;
        this.failed = false;
        this.startupCallback = callback;
        const hasStartupCallback = typeof callback === 'function';
        let authenticationRejected = false;
        const startTime = Date.now();
        this.process = (0, child_process_1.spawn)(videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
        this.stdin = this.process.stdin;
        const fail = (message) => {
            if (this.failed || this.stopping) {
                return;
            }
            this.failed = true;
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
        stderr.on('line', (line) => {
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
            fail('FFmpeg process failed: ' + error.message);
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
            if (this.stopping) {
                log.debug(message + ' (Expected)', cameraName, debug);
            }
            else {
                fail((!this.started && authenticationRejected ? 'Camera authentication was rejected. ' : '') + message);
            }
        };
        this.process.on('exit', onExit);
        // A failed spawn can emit error and close without an exit event.
        this.process.on('close', onExit);
        if (typeof this.startupCallback === 'function') {
            this.startupTimeout = setTimeout(() => {
                fail(authenticationRejected
                    ? 'Camera authentication was rejected before a video frame was received.'
                    : 'FFmpeg did not produce a video frame within 20 seconds. Check the stream URL and camera reachability.');
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
        this.finishStartup(new Error('FFmpeg stopped before receiving a video frame.'));
        this.process.kill('SIGTERM');
        if (!this.exited) {
            this.killTimeout = setTimeout(() => {
                if (!this.exited) {
                    this.process.kill('SIGKILL');
                }
            }, 2 * 1000);
        }
    }
}
exports.FfmpegProcess = FfmpegProcess;
//# sourceMappingURL=ffmpeg.js.map
