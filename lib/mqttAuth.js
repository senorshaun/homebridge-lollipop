'use strict';

const crypto = require('crypto');
const tls = require('tls');

// Public trust anchor bundled in signed Android APKs 3.11.11 and 4.5.2 as
// assets/lollipop.ca.crt. It is not the downloaded client identity.
// SHA-256: 22baeb6e2d10e9589c39912eee0bd4a3eab5aec8ac4542753c9aaec407157836
const LOLLIPOP_CA = `-----BEGIN CERTIFICATE-----
MIIDkzCCAnugAwIBAgIJANOcAu3SS6pcMA0GCSqGSIb3DQEBCwUAMF8xCzAJBgNV
BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX
aWRnaXRzIFB0eSBMdGQxGDAWBgNVBAMMD2xvbGxpcG9wLmNhbWVyYTAgFw0xNzA5
MjUwMTM0MTBaGA8yMTE3MDkwMTAxMzQxMFowXzELMAkGA1UEBhMCQVUxEzARBgNV
BAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdpdHMgUHR5IEx0
ZDEYMBYGA1UEAwwPbG9sbGlwb3AuY2FtZXJhMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAw8NgyxmKEC2Yf3QpfriNdj/UnoDbgVxkp5ISnAQoHxY7MTrR
M0eZJ4sm2O9l76JVkDGs1vxcwbuXzWx09dAryNbZIfOdvZt+/XhzecXXZ4Z+LdjY
J+q0IUDBOZZmQgBlLrbidmSDx5ANgr5mcFJTgnzTc0BQQbDOD3uC63UvVh/QECHb
pAkE6Mw5FhPCojX54r+B2umNMD3VqwhGlC7Y4GQOqdNPKEl0O2fUMJi1hV+Z/wqZ
Ee5s6CIgCnBqIV/rUXnwMOPfUvDPA0hMWL4VSUJe6tp5tW/o5kwP41DXTT8BCjEN
GRbjyOgYp35RZaf+qZia/j1wboipaKf1anUoOQIDAQABo1AwTjAdBgNVHQ4EFgQU
/kc/U4zcQU8Gcddr2b35ScRL+q0wHwYDVR0jBBgwFoAU/kc/U4zcQU8Gcddr2b35
ScRL+q0wDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAsxySRuFYbojR
fLt3ZFb22P+QFZNLYFuhDdWKwEfd/qU4ctZzuL6nvA3Ex5YS/4fJ5UU9ymRSdvii
q5j8q47yBEDsVkAN4+HnGbYYLoVpIgmo2rYYfp9UPOY4AWcl3M7ko1swfubf2GmA
ME07vQ0ir1eHgSk0qLIauLWUE95pizi8lxStoN1amNOkgiCH7Ea6HiAYtfccGkwG
TA/TtCLGpJyvGjyFvceesMZTdHI17blJ5irYZAMg6sD+snkATTbF2R6oWch66swL
QdvQJhut/Y+iMav0gw/8sE2sjcQOZOg24NbaOgEYFPW+VzPlU0H4iKMN7F7vaCDS
tcDtQnWwYw==
-----END CERTIFICATE-----
`;

const MQTT_AUTH_CONSTANT = '6A09E667BB67AE853C6EF372';
const MAX_PEM_BYTES = 1024 * 1024;

function authError(code, message) {
    return Object.assign(new Error(message), { code });
}

function mqttPassword(cameraId) {
    // The same ID is also a literal topic component, so MQTT wildcards and
    // separators must never be admitted here.
    if (typeof cameraId !== 'string' || !cameraId || cameraId.length > 512 ||
        /[\s:/#+\u0000-\u001f\u007f]/.test(cameraId)) {
        throw authError('MQTT_CAMERA_ID_INVALID', 'The account did not provide a valid camera ID.');
    }
    // This input intentionally omits the username, unlike RTSP authentication.
    return crypto.createHash('md5').update(cameraId + ':' + MQTT_AUTH_CONSTANT, 'utf8').digest('hex');
}

function pemBytes(value, code, description) {
    if ((!Buffer.isBuffer(value) && typeof value !== 'string') || !value.length ||
        Buffer.byteLength(value) > MAX_PEM_BYTES) {
        throw authError(code, description);
    }
    return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
}

function certificatePublicKey(certificate) {
    const text = certificate.toString('utf8');
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!blocks || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) {
        throw new Error('Invalid certificate encoding');
    }
    // createPublicKey supports X.509 PEM certificates on Node 14. Parse every
    // supplied chain entry, but compare the leaf (first) to the private key.
    return blocks.map(block => crypto.createPublicKey(block))[0];
}

function trustPrivateCameraCA() {
    // In both inspected APKs Paho's sslHostnameVerifier defaults to null and the
    // app never sets it. The TLS trust manager still validates the camera chain
    // against lollipop.ca.crt. Mirror that for DHCP/local-IP connections only
    // when using this private vendor CA. Node checks certificate trust/validity
    // before calling this function; rejectUnauthorized stays true.
    // This authenticates the vendor PKI, not an individual camera hostname.
    // Callers must also limit and check MQTT topics against the selected ID.
    return undefined;
}

function createAuthenticatedMqttOptions({ cameraId, cert, key, ca } = {}) {
    const password = mqttPassword(cameraId);
    const certificate = pemBytes(cert, 'MQTT_CLIENT_CERT_INVALID', 'The downloaded MQTT client certificate is invalid.');
    const privateKey = pemBytes(key, 'MQTT_CLIENT_KEY_INVALID', 'The downloaded MQTT private key is invalid.');
    const useAppCA = ca === undefined;
    const authority = pemBytes(useAppCA ? LOLLIPOP_CA : ca, 'MQTT_CA_INVALID', 'The MQTT trust certificate is invalid.');
    let certificateKey;
    let keyPublicKey;
    try {
        certificateKey = certificatePublicKey(certificate).export({ type: 'spki', format: 'der' });
    } catch (_) {
        throw authError('MQTT_CLIENT_CERT_INVALID', 'The downloaded MQTT client certificate is invalid.');
    }
    try {
        keyPublicKey = crypto.createPublicKey(crypto.createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' });
    } catch (_) {
        throw authError('MQTT_CLIENT_KEY_INVALID', 'The downloaded MQTT private key is invalid or encrypted.');
    }
    if (!certificateKey.equals(keyPublicKey)) {
        throw authError('MQTT_CLIENT_IDENTITY_MISMATCH', 'The downloaded MQTT certificate and private key do not match.');
    }
    try {
        certificatePublicKey(authority);
    } catch (_) {
        throw authError('MQTT_CA_INVALID', 'The MQTT trust certificate is invalid.');
    }
    let secureContext;
    try {
        // Check OpenSSL can actually load this identity before opening a socket.
        // Do not expose OpenSSL errors: their details can include supplied data.
        secureContext = tls.createSecureContext({ cert: certificate, key: privateKey, ca: authority, minVersion: 'TLSv1.2' });
    } catch (_) {
        throw authError('MQTT_CLIENT_IDENTITY_INVALID', 'The MQTT client identity could not be loaded for TLS.');
    }

    // getCertificate() is available on Node 14, whereas X509Certificate is not.
    // An unconnected TLSSocket exposes the loaded local certificate without
    // contacting any server. Always destroy it, including on a parsing failure.
    let socket;
    let details;
    try {
        socket = new tls.TLSSocket(undefined, { secureContext });
        details = socket.getCertificate();
    } catch (_) {
        throw authError('MQTT_CLIENT_CERT_INVALID', 'The downloaded MQTT client certificate is invalid.');
    } finally {
        if (socket) socket.destroy();
    }
    const validFrom = Date.parse(details && details.valid_from);
    const validTo = Date.parse(details && details.valid_to);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
        throw authError('MQTT_CLIENT_CERT_INVALID', 'The downloaded MQTT client certificate has invalid validity dates.');
    }
    const now = Date.now();
    if (now < validFrom) {
        throw authError('MQTT_CLIENT_CERT_NOT_YET_VALID', 'The MQTT client certificate is not valid yet. Check the Homebridge clock.');
    }
    if (now >= validTo) {
        throw authError('MQTT_CLIENT_CERT_EXPIRED', 'The MQTT client certificate has expired. Refresh the account credentials.');
    }

    return {
        username: 'lollipop',
        password,
        cert: certificate,
        key: privateKey,
        ca: authority,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        // The ca injection is for isolated tests; an alternative trust anchor
        // retains Node's usual hostname verification. It is not a config field.
        checkServerIdentity: useAppCA ? trustPrivateCameraCA : tls.checkServerIdentity
    };
}

module.exports = { mqttPassword, createAuthenticatedMqttOptions };
