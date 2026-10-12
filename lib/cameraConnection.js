"use strict";

const crypto = require('crypto');
const net = require('net');

// Recovered from the author's original beta.5 implementation. This is literal
// uppercase text in the MD5 input, not hexadecimal bytes to decode.
const RTSP_AUTH_CONSTANT = '6A09E667BB67AE853C6EF372';
const md5 = value => crypto.createHash('md5').update(value, 'utf8').digest('hex');
const configured = value => value !== undefined && value !== '';

function hasDirectStreamConfig(config) {
    return configured(config.rtspUrl) || configured(config.cameraId);
}

function parseRtspUrl(value, ip, pairingID) {
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
    if (ip && String(ip).replace(/^\[|\]$/g, '').toLowerCase() !== hostname.toLowerCase()) {
        throw new Error('The camera IP/hostname must match the host in the RTSP URL.');
    }
    return {
        ip: hostname,
        pairingID: typeof pairingID === 'string' && pairingID ? pairingID : undefined,
        source: '-rtsp_transport tcp -i ' + url.href
    };
}

function cameraHost(value) {
    if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('Enter the camera IP address or hostname with cameraId.');
    }
    const host = value.replace(/^\[|\]$/g, '');
    if (net.isIP(host) === 6) {
        if (value !== host && value !== '[' + host + ']') {
            throw new Error('Enter a valid camera IPv6 address.');
        }
        return '[' + host + ']';
    }
    if (net.isIP(value) === 4) return value;
    const labels = value.replace(/\.$/, '').split('.');
    if (value.length > 253 || /^[\d.]+$/.test(value) || labels.some(label =>
        !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
        throw new Error('Enter only the camera IP address or hostname, without a URL, port, or path.');
    }
    return value;
}

function resolveCameraConnection(config) {
    // An explicit URL remains an escape hatch for cameras whose firmware uses a
    // different credential scheme or stream path.
    if (configured(config.rtspUrl)) {
        return parseRtspUrl(config.rtspUrl, config.ip, config.pairingID);
    }
    const pairingID = config.cameraId;
    if (typeof pairingID !== 'string' || !pairingID || /[\s:\u0000-\u001f\u007f]/.test(pairingID)) {
        throw new Error('Enter the camera pairing ID as cameraId, without spaces or colons.');
    }
    const username = configured(config.rtspUsername) ? config.rtspUsername : 'homebridge';
    if (typeof username !== 'string' || !username.trim() || /[:\u0000-\u001f\u007f]/.test(username)) {
        throw new Error('Enter an RTSP username without colons or control characters.');
    }
    const url = new URL('rtsp://' + cameraHost(config.ip) + ':554/live/' + md5(pairingID) + '/ch00_0');
    url.username = encodeURIComponent(username);
    url.password = md5(username + ':' + pairingID + ':' + RTSP_AUTH_CONSTANT);
    return parseRtspUrl(url.href, undefined, pairingID);
}

module.exports = { resolveCameraConnection, hasDirectStreamConfig };
