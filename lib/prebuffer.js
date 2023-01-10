"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreBuffer = void 0;
const child_process_1 = require("child_process");
const events_1 = __importDefault(require("events"));
const net_1 = require("net");
const recordingDelegate_1 = require("./recordingDelegate");
const defaultPrebufferDuration = 15000;

class PreBuffer {
    constructor(log, ffmpegInput, cameraName, videoProcessor) {
        this.prebufferFmp4 = [];
        this.events = new events_1.default();
        this.released = false;
        this.idrInterval = 0;
        this.prevIdr = 0;
        this.log = log;
        this.ffmpegInput = ffmpegInput;
        this.cameraName = cameraName;
        this.ffmpegPath = videoProcessor;
    }
    async startPreBuffer() {
        if (this.prebufferSession)
            return this.prebufferSession;
        this.log.debug("Starting prebuffer", this.cameraName);
        const acodec = [
            '-acodec',
            'copy',
        ];
        const vcodec = [
            '-vcodec',
            'copy',
        ];
        const fmp4OutputServer = (0, net_1.createServer)(async (socket) => {
            fmp4OutputServer.close();
            const parser = (0, recordingDelegate_1.parseFragmentedMP4)(socket);
            for await (const atom of parser) {
                const now = Date.now();
                if (!this.ftyp) {
                    this.ftyp = atom;
                }
                else if (!this.moov) {
                    this.moov = atom;
                }
                else {
                    if (atom.type === 'mdat') {
                        if (this.prevIdr)
                            this.idrInterval = now - this.prevIdr;
                        this.prevIdr = now;
                    }
                    this.prebufferFmp4.push({
                        atom,
                        time: now,
                    });
                }
                while (this.prebufferFmp4.length && this.prebufferFmp4[0].time < now - defaultPrebufferDuration) {
                    this.prebufferFmp4.shift();
                }
                this.events.emit('atom', atom);
            }
        });
        const fmp4Port = await (0, recordingDelegate_1.listenServer)(fmp4OutputServer);
        const ffmpegOutput = [
            '-f', 'mp4',
            ...vcodec,
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            `tcp://127.0.0.1:${fmp4Port}`
        ];
        const args = [];
        args.push(...this.ffmpegInput.split(" "));
        args.push(...ffmpegOutput);
        this.log.debug(this.ffmpegPath + " " + args.join(" "), this.cameraName);
        let debug = false;
        let stdioValue = debug ? "pipe" : "ignore";
        let cp = (0, child_process_1.spawn)(this.ffmpegPath, args, { env: process.env, stdio: stdioValue });
        if (debug) {
            cp.stdout.on('data', data => this.log.debug(data.toString(), this.cameraName));
            cp.stderr.on('data', data => this.log.debug(data.toString(), this.cameraName));
        }
        this.prebufferSession = { server: fmp4OutputServer, process: cp };
        return this.prebufferSession;
    }
    async getVideo(requestedPrebuffer) {
        const server = new net_1.Server(socket => {
            server.close();
            let cleanup;
            const writeAtom = (atom) => {
                socket.write(Buffer.concat([atom.header, atom.data]));
            };
            if (this.ftyp) {
                writeAtom(this.ftyp);
            }
            if (this.moov) {
                writeAtom(this.moov);
            }
            const now = Date.now();
            let needMoof = true;
            for (const prebuffer of this.prebufferFmp4) {
                if (prebuffer.time < now - requestedPrebuffer)
                    continue;
                if (needMoof && prebuffer.atom.type !== 'moof')
                    continue;
                needMoof = false;
                writeAtom(prebuffer.atom);
            }
            this.events.on('atom', writeAtom);
            cleanup = () => {
                this.log.info('broadcast request ended', this.cameraName);
                this.events.removeListener('atom', writeAtom);
                this.events.removeListener('killed', cleanup);
                socket.removeAllListeners();
                socket.destroy();
            };
            this.events.once('killed', cleanup);
            socket.once('end', cleanup);
            socket.once('close', cleanup);
            socket.once('error', cleanup);
        });
        setTimeout(() => server.close(), 30000);
        const port = await (0, recordingDelegate_1.listenServer)(server);
        const ffmpegInput = [
            '-f', 'mp4',
            '-i', `tcp://127.0.0.1:${port}`,
        ];
        return ffmpegInput;
    }
}
exports.PreBuffer = PreBuffer;
//# sourceMappingURL=prebuffer.js.map