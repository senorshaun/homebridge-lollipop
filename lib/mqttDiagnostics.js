'use strict';
const { safeErrorCode } = require('./diagnostics');

function observeMqtt(client, onFailure, onDiagnostic) {
    const streams = new WeakSet();
    const errors = new WeakSet();
    let active = true;
    let stage = 'TLS handshake';
    let attempt = 0;
    let started = Date.now();
    const diagnostic = (event, fields) => {
        if (!active || typeof onDiagnostic !== 'function') return;
        try { onDiagnostic(event, fields); } catch (_) { /* Diagnostics cannot affect MQTT. */ }
    };

    const report = (error, stream) => {
        if (!active || (error && typeof error === 'object' && errors.has(error))) return;
        if (error && typeof error === 'object') errors.add(error);
        if (stream && stream !== client.stream) return;
        diagnostic('mqtt.connection', { phase: 'failed', stage, attempt, code: safeErrorCode(error && error.code), durationMs: Date.now() - started });
        onFailure(error, stage);
    };
    const observeStream = stream => {
        if (!active || !stream || streams.has(stream)) return;
        streams.add(stream);
        stage = 'TLS handshake';
        started = Date.now();
        attempt++;
        diagnostic('mqtt.tls', { phase: 'start', attempt, stage });
        stream.on('secureConnect', () => {
            if (!active || stream !== client.stream) return;
            stage = 'waiting for MQTT CONNECT acceptance';
            let protocol, cipher;
            try {
                protocol = stream.getProtocol && stream.getProtocol();
                cipher = stream.getCipher && stream.getCipher();
            } catch (_) { /* Some MQTT transports do not expose TLS metadata. */ }
            diagnostic('mqtt.tls', {
                phase: 'secure', attempt, stage, protocol, cipher: cipher && cipher.name,
                authorized: stream.authorized === true, durationMs: Date.now() - started
            });
        });
        // MQTT.js 4.2.8 can suppress TLS errors when rejectUnauthorized is false.
        stream.on('error', error => report(error, stream));
    };
    const observeConnectPacket = packet => {
        if (packet.cmd === 'connect') observeStream(client.stream);
    };
    const mqttAccepted = packet => {
        if (!active) return;
        stage = 'MQTT session';
        diagnostic('mqtt.connection', {
            phase: 'connected', attempt, stage, sessionPresent: !!(packet && packet.sessionPresent), durationMs: Date.now() - started
        });
    };

    client.on('error', error => report(error));
    client.on('connect', mqttAccepted);
    // The reconnect event precedes stream replacement in MQTT.js 4.2.8.
    // CONNECT packetsend occurs after replacement, including automatic retries.
    client.on('packetsend', observeConnectPacket);
    observeStream(client.stream);

    return {
        getStage: () => stage,
        setStage: value => { if (active) stage = value; },
        stop() {
            active = false;
            client.removeListener('connect', mqttAccepted);
            client.removeListener('packetsend', observeConnectPacket);
            // Retain inert error listeners so late errors during close stay handled.
        }
    };
}

const reasons = {
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ENOTFOUND: 'camera host not found',
    ETIMEDOUT: 'connection timed out',
    EHOSTUNREACH: 'camera host unreachable',
    ENETUNREACH: 'camera network unreachable',
    MQTT_CONNACK_1: 'MQTT protocol version rejected',
    MQTT_CONNACK_2: 'MQTT client ID rejected',
    MQTT_CONNACK_3: 'MQTT server unavailable',
    MQTT_CONNACK_4: 'MQTT username or password rejected',
    MQTT_CONNACK_5: 'MQTT connection not authorized',
    MQTT_SUBSCRIPTION_DENIED: 'topic subscription denied by SUBACK',
    MQTT_DISCOVERY_TIMEOUT: 'camera ID discovery timed out',
    MQTT_CONNECTION_CLOSED: 'connection closed before discovery completed'
};

function describeMqttFailure(error, stage) {
    const code = safeErrorCode(error && error.code);
    let reason = reasons[code] || 'connection error';
    if (code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
        // Recognize only fixed descriptions; never print raw errors or credential URLs.
        const message = typeof error.message === 'string' ? error.message : '';
        if (/CERTIFICATE_REQUIRED/.test(code) || /certificate required/i.test(message)) {
            reason = 'server requires a client certificate';
        } else if (/protocol version|unsupported protocol|wrong version number/i.test(message)) {
            reason = 'TLS protocol negotiation failed';
        } else if (/no shared cipher/i.test(message)) {
            reason = 'TLS cipher negotiation failed';
        } else if (/handshake failure/i.test(message)) {
            reason = 'TLS handshake rejected';
        } else {
            reason = 'TLS connection failed';
        }
    }
    return 'during ' + stage + ' [' + code + ': ' + reason + ']';
}

module.exports = { observeMqtt, describeMqttFailure };
