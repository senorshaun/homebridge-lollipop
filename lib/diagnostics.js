'use strict';

const tls = require('tls');

// Diagnostic records contain a deliberately small vocabulary. Do not add a
// free-form message, URL, topic, response, Error, or credential field here.
// Changes in a vendor response remain visible through its type, byte count,
// HTTP/Parse code, and the operation that failed, without copying that response.
const EVENTS = new Set([
    'platform.start', 'platform.refresh', 'platform.camera', 'platform.shutdown',
    'account.request', 'account.response', 'account.login', 'account.sign_in', 'account.otp',
    'account.session', 'account.cache', 'account.cameras', 'account.discovery',
    'account.credentials', 'account.identity', 'account.download', 'account.storage',
    'account.close', 'account.error',
    'account.created', 'account.cache.write', 'account.cache.read',
    'account.http.request', 'account.http.transport', 'account.http.error',
    'account.http.response', 'account.http.rejected', 'account.response.structure',
    'account.response.result', 'account.cache.invalidate', 'account.authenticate',
    'account.cache.eligibility', 'account.cameras.page', 'account.camera',
    'account.identity.validation', 'account.credential.download', 'account.identity.checksum',
    'setup.request.start', 'setup.request.complete', 'setup.request.failed',
    'mqtt.connect', 'mqtt.connection', 'mqtt.tls', 'mqtt.subscription', 'mqtt.message',
    'sound.command', 'sound.status', 'media', 'media.start', 'media.snapshot',
    'media.stream', 'media.exit', 'media.error', 'camera.sensor'
]);

const CODES = new Set([
    'UNKNOWN', 'INVALID_ACCOUNT', 'INVALID_CREDENTIALS', 'INVALID_SESSION',
    'SIGN_IN_REQUIRED', 'OTP_REQUIRED', 'INVALID_OTP', 'NO_OTP_CHALLENGE',
    'NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'TLS_ERROR',
    'INVALID_RESPONSE', 'ACCESS_DENIED', 'STORAGE_ERROR', 'CHECKSUM_MISMATCH',
    'INVALID_CERTIFICATE', 'UNKNOWN_CAMERA', 'CLOSED', 'ACCOUNT_ERROR',
    'ACCOUNT_UNAVAILABLE', 'INVALID_REQUEST', 'INVALID_CONFIG',
    'MQTT_CAMERA_ID_INVALID', 'MQTT_CLIENT_CERT_INVALID', 'MQTT_CLIENT_KEY_INVALID',
    'MQTT_CA_INVALID', 'MQTT_CLIENT_IDENTITY_MISMATCH', 'MQTT_CLIENT_IDENTITY_INVALID',
    'MQTT_CLIENT_CERT_EXPIRED', 'MQTT_CLIENT_CERT_NOT_YET_VALID',
    'MQTT_SUBSCRIPTION_DENIED', 'MQTT_DISCOVERY_TIMEOUT', 'MQTT_CONNECTION_CLOSED',
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH',
    'ENETDOWN', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EPIPE', 'EPROTO', 'EINVAL',
    'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EROFS', 'ECANCELED',
    'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_WRITE_AFTER_END',
    'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ABORT_ERR',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
    'CERT_UNTRUSTED', 'CERT_REJECTED', 'INVALID_CA', 'INVALID_PURPOSE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_CRL', 'PATH_LENGTH_EXCEEDED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_ALTNAME_FORMAT',
    'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
    'ERR_TLS_INVALID_PROTOCOL_VERSION', 'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
    'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_TLS_DH_PARAM_SIZE', 'ERR_TLS_RENEGOTIATION_DISABLED',
    'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
    'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
    'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
    'ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
    'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_TLSV1_ALERT_ACCESS_DENIED',
    'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR',
    'ERR_SSL_CERTIFICATE_VERIFY_FAILED', 'ERR_SSL_NO_SHARED_CIPHER',
    'ERR_SSL_NO_CIPHERS_AVAILABLE', 'ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM',
    'ERR_SSL_UNSUPPORTED_PROTOCOL', 'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_EE_KEY_TOO_SMALL', 'ERR_SSL_CA_KEY_TOO_SMALL', 'ERR_SSL_CA_MD_TOO_WEAK',
    'ERR_SSL_UNEXPECTED_EOF_WHILE_READING', 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
    'ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_PEM_BAD_BASE64_DECODE',
    'ERR_OSSL_UNSUPPORTED', 'ERR_OSSL_ASN1_TOO_LONG', 'ERR_OSSL_ASN1_HEADER_TOO_LONG',
    'ERR_OSSL_ASN1_WRONG_TAG', 'ERR_OSSL_ASN1_NESTED_ASN1_ERROR'
]);
// MQTT 3.1.1 CONNACK values plus the defined MQTT 5 connection failure values.
const MQTT_CODES = new Set([0, 1, 2, 3, 4, 5, 128, 129, 130, 131, 132, 133, 134,
    135, 136, 137, 138, 139, 140, 144, 149, 151, 153, 154, 155, 156, 157, 159]);
for (const code of MQTT_CODES) CODES.add('MQTT_CONNACK_' + code);

function safeErrorCode(value) {
    if (typeof value === 'number' && MQTT_CODES.has(value)) return 'MQTT_CONNACK_' + value;
    return typeof value === 'string' && CODES.has(value) ? value : 'UNKNOWN';
}

const enumValue = values => {
    const allowed = new Set(values);
    return value => typeof value === 'string' ? (allowed.has(value) ? value : 'UNKNOWN') : undefined;
};
const numberValue = value => typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= 1e12 ? value : undefined;
const booleanValue = value => typeof value === 'boolean' ? value : undefined;
const typeValue = enumValue(['undefined', 'null', 'object', 'array', 'string', 'number',
    'boolean', 'buffer', 'integer', 'missing', 'unknown']);
const versionValue = value => typeof value === 'string' &&
    /^v?\d{1,4}\.\d{1,4}(?:\.\d{1,6}){0,2}(?:-(?:alpha|beta|rc|dev|nightly|pre|test|snapshot)(?:[.-]\d{1,8})?)?(?:\+\d{1,16})?$/i.test(value)
    ? value : (typeof value === 'string' ? 'UNKNOWN' : undefined);
const referenceValue = prefix => value => typeof value === 'string' &&
    new RegExp('^' + prefix + '-[1-9][0-9]{0,5}$').test(value) ? value : undefined;

const phases = [
    'start', 'complete', 'failed', 'scheduled', 'skipped', 'selected', 'missing_address',
    'configured', 'updated', 'removed', 'connected', 'close', 'offline', 'reconnect',
    'end', 'retry', 'received', 'malformed', 'ignored', 'requested', 'published',
    'acknowledged', 'confirmed', 'timeout', 'rejected', 'first_frame', 'exit',
    'cancelled', 'pending', 'validated', 'validation', 'read', 'write', 'load',
    'save', 'hit', 'miss', 'expired', 'invalidated', 'refresh', 'download',
    'parse', 'verify', 'challenge', 'authenticated', 'connecting', 'ready',
    'cert_parse', 'key_parse', 'pair_match', 'validity', 'identity_parse',
    'transport', 'response', 'required', 'normalize', 'pagination', 'url',
    'request', 'redirect', 'key_link', 'checksum', 'secure', 'status',
    'prepare', 'process', 'fetch', 'resize', 'signal',
    'TLS handshake', 'waiting for MQTT CONNECT acceptance', 'MQTT session',
    'topic subscription', 'waiting for camera ID'
];
const reasons = [
    'startup', 'periodic', 'authentication', 'busy', 'shutdown', 'wrong_camera',
    'not_ready', 'unknown_topic', 'invalid_json', 'disconnected', 'invalid_input',
    'publish_error', 'camera_rejected', 'confirmation_timeout', 'network',
    'network_error', 'invalid_response', 'invalid_session', 'access_denied',
    'rate_limited', 'service_unavailable', 'tls_error', 'checksum_mismatch',
    'invalid_certificate', 'storage_error', 'missing', 'expired', 'stale',
    'forced', 'fresh', 'valid', 'invalid', 'unavailable', 'no_address',
    'no_cameras', 'no_session', 'no_password', 'no_credentials', 'disabled',
    'configured', 'cached', 'fallback', 'cache_expired', 'cache_miss', 'cache_hit',
    'session_expired', 'otp_required', 'retry', 'success', 'unknown',
    'connection refused', 'connection reset', 'camera host not found',
    'connection timed out', 'camera host unreachable', 'camera network unreachable',
    'MQTT protocol version rejected', 'MQTT client ID rejected',
    'MQTT server unavailable', 'MQTT username or password rejected',
    'MQTT connection not authorized', 'topic subscription denied by SUBACK',
    'camera ID discovery timed out', 'connection closed before discovery completed',
    'server requires a client certificate', 'TLS protocol negotiation failed',
    'TLS cipher negotiation failed', 'TLS handshake rejected', 'TLS connection failed',
    'connection error', 'missing_pem_marker', 'invalid_date', 'not_yet_valid',
    'key_mismatch', 'invalid_pem', 'request_failure', 'timeout', 'response_too_large',
    'response_failure', 'response_aborted', 'request_setup', 'initialize',
    'configured_session', 'invalid_status', 'invalid_body', 'session_rejected',
    'session_saved', 'invalid_user', 'session_validated', 'invalid_results',
    'invalid_camera_record', 'duplicate_id', 'camera_list_saved', 'page_limit',
    'invalid_pem_storage', 'cert_checksum_mismatch', 'key_checksum_mismatch',
    'invalid_checksum_format', 'identity_saved', 'spawn_error', 'startup_timeout',
    'rtsp_authentication', 'ffmpeg_exit', 'stop', 'empty_snapshot', 'rtcp_timeout',
    'socket_error', 'invalid_schema'
];

let ciphers;
try { ciphers = new Set(tls.getCiphers().map(cipher => cipher.toUpperCase())); }
catch (_) { ciphers = new Set(); }

// The insertion order also defines the stable order in every emitted record.
const FIELDS = {
    operation: enumValue(['login', 'otp', 'session', 'cameras', 'mqtt_key',
        'cert_download', 'key_download', 'snapshot', 'stream', 'refresh',
        'discovery', 'credentials', 'identity', 'status', 'cancel', 'read', 'write', 'account']),
    route: enumValue(['/account/login', '/account/otp', '/account/status',
        '/account/cancel', '/account/debug', 'unknown']),
    phase: enumValue(phases),
    stage: enumValue(phases),
    outcome: enumValue(['success', 'failed', 'failure', 'error', 'authenticated',
        'otp_required', 'cancelled', 'cached', 'fresh', 'hit', 'miss', 'accepted',
        'rejected', 'valid', 'invalid', 'skipped', 'pending', 'complete', 'unavailable',
        'in_flight', 'preserved_new_session']),
    source: enumValue(['cloud', 'cache', 'config', 'configured', 'session', 'password',
        'disk', 'memory', 'network', 'account', 'direct', 'legacy', 'ui', 'runtime']),
    reason: enumValue(reasons),
    scope: enumValue(['account', 'camera', 'session', 'identity', 'cameras', 'credentials', 'mqtt']),
    file: enumValue(['cert', 'key', 'certificate', 'private_key', 'store']),
    cacheType: enumValue(['state', 'session', 'camera', 'cameras', 'identity', 'credentials']),
    mode: enumValue(['account', 'direct', 'legacy', 'manual']),
    requestId: numberValue,
    commandId: numberValue,
    cameraRef: referenceValue('camera'),
    streamRef: referenceValue('stream'),
    code: safeErrorCode,
    errorCode: safeErrorCode,
    networkCode: safeErrorCode,
    systemCode: safeErrorCode,
    durationMs: numberValue,
    delayMs: numberValue,
    statusCode: numberValue,
    parseCode: numberValue,
    attempt: numberValue,
    cameraCount: numberValue,
    page: numberValue,
    count: numberValue,
    bytes: numberValue,
    certBytes: numberValue,
    keyBytes: numberValue,
    redirects: numberValue,
    cacheAgeMs: numberValue,
    ageMs: numberValue,
    ttlMs: numberValue,
    certExpiresInDays: numberValue,
    daysRemaining: numberValue,
    generation: numberValue,
    limit: numberValue,
    withAddress: numberValue,
    withoutAddress: numberValue,
    withRtspUrl: numberValue,
    topicCount: numberValue,
    grantedCount: numberValue,
    deniedCount: numberValue,
    qos: numberValue,
    port: numberValue,
    confirmationTimeoutMs: numberValue,
    width: numberValue,
    height: numberValue,
    fps: numberValue,
    bitrate: numberValue,
    frames: numberValue,
    exitCode: numberValue,
    diagnosticsVersion: numberValue,
    hasSessionToken: booleanValue,
    hasSession: booleanValue,
    hasPassword: booleanValue,
    hasTimestamp: booleanValue,
    hasAddress: booleanValue,
    hasRtspUrl: booleanValue,
    hasChallenge: booleanValue,
    hasCameras: booleanValue,
    hasIdentity: booleanValue,
    hasResult: booleanValue,
    hasParams: booleanValue,
    credentialsPresent: booleanValue,
    authenticated: booleanValue,
    requiresOtp: booleanValue,
    authorized: booleanValue,
    subscribed: booleanValue,
    sessionPresent: booleanValue,
    connected: booleanValue,
    knownState: booleanValue,
    enabled: booleanValue,
    eligible: booleanValue,
    forced: booleanValue,
    cached: booleanValue,
    valid: booleanValue,
    matches: booleanValue,
    audio: booleanValue,
    returnAudio: booleanValue,
    soundEnabled: booleanValue,
    hksv: booleanValue,
    active: booleanValue,
    addressChanged: booleanValue,
    identityChanged: booleanValue,
    discoveryPending: booleanValue,
    resultType: typeValue,
    responseType: typeValue,
    bodyType: typeValue,
    resultsType: typeValue,
    sessionTokenType: typeValue,
    timestampType: typeValue,
    objectIdType: typeValue,
    certType: typeValue,
    keyType: typeValue,
    certChecksumType: typeValue,
    keyChecksumType: typeValue,
    addressType: typeValue,
    hostType: enumValue(['ipv4', 'ipv6', 'hostname', 'missing', 'unknown']),
    protocol: enumValue(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3', 'SSLv3',
        'MQTTv3.1', 'MQTTv3.1.1', 'MQTTv5', 'mqtts', 'rtsp', 'rtsps', 'https', 'unknown']),
    cipher: value => typeof value === 'string' ?
        (ciphers.has(value.toUpperCase()) ? value : 'UNKNOWN') : undefined,
    topicKind: enumValue(['liveNote', 'prenotify', 'musicStatus', 'controlMusic',
        'cameraStatus', 'other']),
    sensorKind: enumValue(['movement', 'crying', 'crossing', 'noise', 'hksv']),
    playStatus: enumValue(['play', 'pause', 'stop', 'unknown']),
    requestedState: enumValue(['on', 'off']),
    requestType: enumValue(['start', 'reconfigure', 'stop']),
    codec: enumValue(['libx264', 'copy', 'h264_v4l2m2m', 'h264_nvenc', 'h264_qsv',
        'h264_vaapi', 'h264_videotoolbox', 'unknown']),
    audioCodec: enumValue(['OPUS', 'AAC-eld', 'unknown']),
    signal: enumValue(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV',
        'SIGPIPE', 'SIGHUP', 'SIGQUIT', 'SIGILL', 'SIGFPE', 'SIGBUS', 'none', 'unknown']),
    pluginVersion: versionValue,
    nodeVersion: versionValue,
    homebridgeVersion: versionValue,
    mqttVersion: versionValue,
    opensslVersion: versionValue,
    ffmpegVersion: versionValue,
    firmwareVersion: value => typeof value === 'string' && /^\d{10}(?:-g[a-f\d]{7,40})?$/i.test(value)
        ? value : versionValue(value),
    platform: enumValue(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']),
    arch: enumValue(['arm', 'arm64', 'ia32', 'x64', 'ppc', 'ppc64', 's390', 's390x',
        'mips', 'mipsel', 'riscv64', 'loong64'])
};

function formatDiagnostic(event, fields, sequence) {
    const safeEvent = typeof event === 'string' && EVENTS.has(event) ? event : 'diagnostic.unknown';
    const safeSequence = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
    const parts = ['[diagnostic #' + safeSequence + ']', safeEvent];
    if (!fields || typeof fields !== 'object') return parts.join(' ');
    for (const name of Object.keys(FIELDS)) {
        // A caller's accidental getter, Proxy, toJSON, or Error must never be
        // evaluated to build a log. Only explicit own scalar data is admitted.
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(fields, name); } catch (_) { continue; }
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
        const raw = descriptor.value;
        if (!['string', 'number', 'boolean'].includes(typeof raw)) continue;
        const value = FIELDS[name](raw);
        if (value === undefined) continue;
        parts.push(name + '=' + (typeof value === 'string' && /\s/.test(value) ? JSON.stringify(value) : value));
    }
    return parts.join(' ');
}

function emitDiagnostic(log, event, fields = {}, device) {
    // Diagnostics must not turn a working camera, account, or UI request into a
    // failure, including when Homebridge supplies a custom or incomplete logger.
    try {
        if (log && typeof log.diagnostic === 'function') log.diagnostic(event, fields, device);
    } catch (_) { /* Logging is best effort. */ }
}

module.exports = { emitDiagnostic, formatDiagnostic, safeErrorCode };
