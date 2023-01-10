"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordingDelegate = exports.parseFragmentedMP4 = exports.readLength = exports.listenServer = exports.FRAGMENTS_LENGTH = exports.PREBUFFER_LENGTH = void 0;
const ffmpeg_for_homebridge_1 = __importDefault(require("ffmpeg-for-homebridge"));
const child_process_1 = require("child_process");
const net_1 = require("net");
const events_1 = require("events");
const prebuffer_1 = require("./prebuffer");
let PREBUFFER_LENGTH;
exports.PREBUFFER_LENGTH = 4000;
exports.FRAGMENTS_LENGTH = 4000;
async function listenServer(server) {
    while (true) {
        const port = 10000 + Math.round(Math.random() * 30000);
        server.listen(port);
        try {
            await (0, events_1.once)(server, 'listening');
            return server.address().port;
        }
        catch (e) {
            this.log.warn("error listening: " + e, this.accessory.displayName);
        }
    }
}
exports.listenServer = listenServer;
async function readLength(readable, length) {
    if (!length) {
        return Buffer.alloc(0);
    }
    {
        const ret = readable.read(length);
        if (ret) {
            return ret;
        }
    }
    return new Promise((resolve, reject) => {
        const r = () => {
            const ret = readable.read(length);
            if (ret) {
                cleanup();
                resolve(ret);
            }
        };
        const e = () => {
            cleanup();
            reject(new Error(`stream ended during read for minimum ${length} bytes`));
        };
        const cleanup = () => {
            readable.removeListener('readable', r);
            readable.removeListener('end', e);
        };
        readable.on('readable', r);
        readable.on('end', e);
    });
}
exports.readLength = readLength;
async function* parseFragmentedMP4(readable) {
    while (true) {
        const header = await readLength(readable, 8);
        const length = header.readInt32BE(0) - 8;
        const type = header.slice(4).toString();
        const data = await readLength(readable, length);
        yield {
            header,
            length,
            type,
            data,
        };
    }
}
exports.parseFragmentedMP4 = parseFragmentedMP4;
class RecordingDelegate {
    constructor(log, accessory, config, api, videoProcessor) {
        this.log = log;
        this.accessory = accessory;
        this.config = config;
        this.videoProcessor = videoProcessor || ffmpeg_for_homebridge_1.default || 'ffmpeg';
        this.handlingStreamingRequest = false;
        this.session = null;
        this.closeReason = null;

        this.startPreBuffer();

        api.on("shutdown" || "SIGTERM", () => {
            var _a, _b;
            if (this.preBufferSession) {
                (_a = this.preBufferSession.process) === null || _a === void 0 ? void 0 : _a.kill();
                (_b = this.preBufferSession.server) === null || _b === void 0 ? void 0 : _b.close();
            }
        });
    }
    async startPreBuffer() {
        if (this.config.prebuffer) {
            if (!this.preBuffer) {
                this.preBuffer = new prebuffer_1.PreBuffer(this.log, this.config.source, this.accessory.displayName, this.videoProcessor);
                if (!this.preBufferSession)
                    this.preBufferSession = await this.preBuffer.startPreBuffer();
            }
        }
    }
    async *handleRecordingStreamRequest(streamId) {
        this.handlingStreamingRequest = true;
        this.closeReason = null;
        this.log.debug("video fragments requested", this.accessory.displayName);
        const iframeIntervalSeconds = 4;
        const audioArgs = [
            '-acodec', 'libfdk_aac',
            ...(this.configuration.audioCodec.type === "AAC-lc" ?
                ['-profile:a', 'aac_low'] :
                ['-profile:a', 'aac_eld']),
            '-ar', `${this.configuration.audioCodec.samplerate}k`,
            '-b:a', `${this.configuration.audioCodec.bitrate}k`,
            '-ac', `${this.configuration.audioCodec.audioChannels}`
        ];
        const profile = this.configuration.videoCodec.profile === 2 ? 'high'
            : this.configuration.videoCodec.profile === 1 ? 'main' : 'baseline';
        const level = this.configuration.videoCodec.level === 2 ? '4.0'
            : this.configuration.videoCodec.level === 1 ? '3.2' : '3.1';
        const videoArgs = [
            '-an',
            '-sn',
            '-dn',
            '-codec:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-profile:v', profile,
            '-level:v', level,
            '-b:v', `${this.configuration.videoCodec.bitrate}k`,
            '-force_key_frames', `expr:eq(t,n_forced*${iframeIntervalSeconds})`,
            '-r', this.configuration.videoCodec.resolution[2].toString(),
        ];
        let ffmpegInput = [];
        ffmpegInput.push(...await this.fetchStream(this.configuration.mediaContainerConfiguration.prebufferLength));
        this.log.debug("Start recording...", this.accessory.displayName);
        this.session = await this.startFFMPegFragmetedMP4Session(this.videoProcessor, ffmpegInput, audioArgs, videoArgs);
        this.log.info("Recording started", this.accessory.displayName);
        let pending = [];
        let filebuffer = Buffer.alloc(0);
        try {
            for await (const box of this.session.generator) {
                const { header, type, length, data } = box;
                pending.push(header, data);

                const motionDetected = this.accessory.getServiceById(this.api.hap.Service.MotionSensor, 'HKSV Sensor').getCharacteristic(this.api.hap.Characteristic.MotionDetected).value;
                
                if (type === 'moov' || type === 'mdat') {
                    const fragment = Buffer.concat(pending);
                    filebuffer = Buffer.concat([filebuffer, Buffer.concat(pending)]);
                    pending = [];
                    yield { 
                        data:fragment,
                        isLast: !motionDetected};
                    if (!motionDetected) {
                        this.log.debug('Ending recording session due to motion stopped', this.accessory.displayName);
                        break;
                    }
                }
                
            }
        }
        catch (error) {
            if (!error.message?.startsWith('FFMPEG')) {
                this.log.info('Encountered unexpected error on generator', this.accessory.displayName);
                this.log.error(error, this.accessory.displayName);
            } else {
                this.log.debug(error, this.accessory.displayName);
            }

        }
        finally {
            if (this.closeReason && this.closeReason !== this.api.hap.HDSProtocolSpecificErrorReason.NORMAL) {
                this.log.warn("Recording process was aborted by HomeKit with reason " + this.api.hap.HDSProtocolSpecificErrorReason[this.closeReason], this.accessory.displayName);
            }
        }
    }
    async startFFMPegFragmetedMP4Session(ffmpegPath, ffmpegInput, audioOutputArgs, videoOutputArgs) {
        return new Promise(async (resolve) => {
            const server = (0, net_1.createServer)(socket => {
                server.close();
                async function* generator() {
                    while (true) {
                        const header = await readLength(socket, 8);
                        const length = header.readInt32BE(0) - 8;
                        const type = header.slice(4).toString();
                        const data = await readLength(socket, length);
                        yield {
                            header,
                            length,
                            type,
                            data,
                        };
                    }
                }
                resolve({
                    socket,
                    cp,
                    generator: generator(),
                });
            });
            const serverPort = await listenServer(server);
            const args = [];
            args.push(...ffmpegInput);
            args.push('-f', 'mp4');
            args.push(...videoOutputArgs);
            args.push('-fflags', '+genpts', '-reset_timestamps', '1');
            args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'tcp://127.0.0.1:' + serverPort);
            this.log.debug(ffmpegPath + " " + args.join(" "), this.accessory.displayName);
            let debug = false;
            let stdioValue = debug ? "pipe" : "ignore";
            this.process = (0, child_process_1.spawn)(ffmpegPath, args, { env: process.env, stdio: stdioValue });
            const cp = this.process;
            if (debug) {
                cp.stdout.on('data', data => this.log.debug(data.toString(), this.accessory.displayName));
                cp.stderr.on('data', data => this.log.debug(data.toString(), this.accessory.displayName));
            }
        });
    }

    updateRecordingActive(active) {

    }

    updateRecordingConfiguration(configuration) {
        this.configuration = configuration;
    }

    async closeRecordingStream(streamId, reason) {
        this.log.info('Closing recording process', this.accessory.displayName);

        if (this.session) {
            this.session.socket?.destroy();
            this.session.cp?.kill('SIGKILL');
            this.session = undefined;
        }
        const motionState = this.accessory.getService(this.api.hap.Service.MotionSensor).getCharacteristic(this.api.hap.Characteristic.MotionDetected).value;

        if (motionState) {
            // this probably means HSV interrupted the recording with an error.
            // turn off the motion sensor so we don't get in a loop
            this.log.debug('Resetting motion session because HomeKit closed the recording process', this.accessory.displayName);
            this.accessory.getService(this.api.hap.Service.MotionSensor).updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false);
        }

        this.closeReason = reason;
        this.handlingStreamingRequest = false;
    }

    acknowledgeStream(streamId) {
        this.closeRecordingStream(streamId);
    }

    async fetchStream(prebufferMilliSeconds) {
        let source = [];
        if (this.config.prebuffer) {
            source.push(...await this.preBuffer.getVideo(prebufferMilliSeconds || 0));
        } else {
            source.push(...this.config.source.split(" "));
        }
        return source;
    }
}
exports.RecordingDelegate = RecordingDelegate;
//# sourceMappingURL=recordingDelegate.js.map