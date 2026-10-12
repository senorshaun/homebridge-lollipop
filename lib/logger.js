"use strict";
class Logger {
    constructor(log, debugMode = false) {
        this.log = log;
        this.debugMode = debugMode || process.argv.includes('-D') || process.argv.includes('--debug');
    }
    formatMessage(message, device) {
        let formatted = '';
        if (device) {
            formatted += '[' + device + '] ';
        }
        formatted += message;
        // Camera URLs include device credentials. FFmpeg can echo them in both
        // commands and failures, including when Homebridge debug mode is on.
        return formatted
            .replace(/\brtsps?:\/\/\S+/gi, '[redacted camera URL]')
            .replace(/(-srtp_out_params\s+)\S+/gi, '$1[redacted]')
            .replace(/(inline:)\S+/gi, '$1[redacted]');
    }
    info(message, device) {
        this.log.info(this.formatMessage(message, device));
    }
    warn(message, device) {
        this.log.warn(this.formatMessage(message, device));
    }
    error(message, device) {
        this.log.error(this.formatMessage(message, device));
    }
    debug(message, device, alwaysLog = false) {
        if (this.debugMode) {
            this.log.info(this.formatMessage(message, device));
        }
        else if (alwaysLog) {
            this.info(message, device);
        } else {
            this.log.debug(this.formatMessage(message, device));
        }
    }
}
exports.Logger = Logger;
