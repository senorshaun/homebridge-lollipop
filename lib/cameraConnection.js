"use strict";

// This accepts a URL obtained from the owner's camera/app. It deliberately does
// not guess a device password from a camera ID or account password.
function resolveCameraConnection(config) {
    const value = config.rtspUrl;
    if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('Enter a complete RTSP URL with special characters percent-encoded.');
    }
    let url;
    try {
        url = new URL(value);
    } catch (_) {
        throw new Error('Enter a valid RTSP URL.');
    }
    if (!['rtsp:', 'rtsps:'].includes(url.protocol) || !url.hostname || url.hash) {
        throw new Error('The camera URL must use rtsp:// or rtsps:// and have no fragment.');
    }
    if (!url.username || !url.password) {
        throw new Error('The camera URL must include its stream username and password.');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (config.ip && String(config.ip).replace(/^\[|\]$/g, '').toLowerCase() !== hostname.toLowerCase()) {
        throw new Error('The camera IP/hostname must match the host in the RTSP URL.');
    }
    return {
        ip: hostname,
        pairingID: typeof config.pairingID === 'string' && config.pairingID ? config.pairingID : undefined,
        source: '-rtsp_transport tcp -i ' + url.href
    };
}

module.exports = { resolveCameraConnection };
