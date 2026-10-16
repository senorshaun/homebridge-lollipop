"use strict";
const { formatDiagnostic } = require('./diagnostics');

const MAX_SECRETS = 256;
// Account cache records include base64-encoded PEM as well as the raw material.
// Accommodate normal certificate chains and RSA-4096 keys without an unbounded
// history of rotated credentials in a process that may run for months.
const MAX_SECRET_LENGTH = 16384;
const MAX_SECRET_CHARACTERS = 262144;
const MAX_MESSAGE_LENGTH = 8192;
const OMITTED = '[log details omitted: credential-redaction limit reached]';
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError',
    'ReferenceError', 'URIError', 'EvalError', 'LollipopAccountError', 'AccountUiError']);

function safeText(value) {
    if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    // Error.message is useful, but never dump its stack, request, response,
    // enumerable properties, or a custom toString/toJSON implementation.
    try {
        if (value instanceof Error) {
            const message = Object.getOwnPropertyDescriptor(value, 'message');
            const name = Object.getOwnPropertyDescriptor(value, 'name');
            const label = name && ERROR_NAMES.has(name.value) ? name.value : 'Error';
            return label + ': ' + (message && typeof message.value === 'string' ? message.value : '[message omitted]');
        }
    } catch (_) { /* A hostile Proxy is not printable diagnostic data. */ }
    return '[object omitted]';
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Logger {
    constructor(log, debugMode = false) {
        this.log = log;
        this.debugMode = debugMode || process.argv.includes('-D') || process.argv.includes('--debug');
        this.diagnosticSequence = 0;
        this.secrets = new Set();
        this.secretCharacters = 0;
        this.secretPattern = undefined;
        this.secretPatternDirty = false;
        this.redactionSaturated = false;
    }
    addSecrets(values) {
        // Register only the already-known account/camera credentials. Never
        // serialize a request, configuration object, or downloaded key here.
        try {
            const entries = typeof values === 'string' ? [values] : values;
            if (!Array.isArray(entries)) return;
            if (entries.length > MAX_SECRETS) this.redactionSaturated = true;
            for (let i = 0; i < Math.min(entries.length, MAX_SECRETS); i++) {
                const descriptor = Object.getOwnPropertyDescriptor(entries, String(i));
                const value = descriptor && descriptor.value;
                if (typeof value !== 'string' || !value || this.secrets.has(value)) continue;
                if (value.length > MAX_SECRET_LENGTH || this.secrets.size >= MAX_SECRETS ||
                    this.secretCharacters + value.length > MAX_SECRET_CHARACTERS) {
                    // Do not evict an earlier secret: an in-flight connection
                    // could still mention it. Omit free-form text if full.
                    this.redactionSaturated = true;
                    continue;
                }
                this.secrets.add(value);
                this.secretCharacters += value.length;
                this.secretPatternDirty = true;
            }
        } catch (_) { this.redactionSaturated = true; }
    }
    redact(message) {
        if (this.redactionSaturated) return OMITTED;
        return this.redactText(message);
    }
    redactText(message) {
        if (this.secretPatternDirty) {
            const patterns = new Set();
            for (const value of this.secrets) {
                patterns.add(escapePattern(value));
                patterns.add(escapePattern(JSON.stringify(value).slice(1, -1)));
                // URLSearchParams uses '+' for spaces; FFmpeg and HTTP clients
                // can use either case in percent escapes, or encode twice.
                let encoded;
                try { encoded = encodeURIComponent(value); } catch (_) { encoded = undefined; }
                if (encoded) {
                    const formEncoded = new URLSearchParams({ v: value }).toString().slice(2);
                    const variants = [encoded, encoded.replace(/%20/g, '+'), formEncoded, encodeURIComponent(encoded)];
                    for (const variant of variants) patterns.add(escapePattern(variant).replace(/%([a-f\d]{2})/gi,
                        (_, hex) => '%' + hex.split('').map(character => /[a-f]/i.test(character)
                            ? '[' + character.toLowerCase() + character.toUpperCase() + ']' : character).join('')));
                }
            }
            const ordered = Array.from(patterns).sort((a, b) => b.length - a.length);
            this.secretPattern = ordered.length ? new RegExp(ordered.join('|'), 'g') : undefined;
            this.secretPatternDirty = false;
        }
        let output = message
            // Redact an entire PEM block, including escaped newlines or an
            // incomplete block. A certificate can itself identify the account.
            .replace(/-----BEGIN ([A-Z\d ]+)-----[\s\S]*?(?:-----END \1-----|$)/g, '[redacted PEM]')
            // All HTTP URLs are excluded, including signed credential download
            // links. The operation name supplies endpoint context in diagnostics.
            .replace(/\brtsps?:\/\/\S+/gi, '[redacted camera URL]')
            .replace(/\b(?:https?|mqtts?|srtp):\/\/\S+/gi, '[redacted URL]')
            .replace(/\b(?:rtsps?|https?|mqtts?)%3[aA]%2[fF]%2[fF]\S+/gi, '[redacted URL]')
            .replace(/(-srtp_out_params\s+)\S+/gi, '$1[redacted]')
            .replace(/(inline:)\S+/gi, '$1[redacted]');
        // Remove complete URLs/PEM blocks before replacing individual secrets:
        // a password equal to "https" or "PRIVATE" must not break recognition.
        if (this.secretPattern) output = output.replace(this.secretPattern, '[redacted]');
        output = output
            // Quoted JSON and common key=value output. Field names are exact:
            // hasPassword, sessionTokenType, and other safe metadata stay useful.
            .replace(/(^|[^\w])(["']?(?:password|passwd|passphrase|sessionToken|session_token|access_token|refresh_token|id_token|token|otp|verificationCode|verification_code|email|username|cameraId|pairingID|privateKey|private_key|clientKey|client_key|authorization|proxy-authorization|x-parse-session-token|cookie|set-cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;}\r\n]+)/gi,
                '$1$2[redacted]')
            // Header and CLI forms may have a scheme or whitespace in a value.
            .replace(/\b((?:proxy-)?authorization|x-parse-session-token|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2[redacted]')
            .replace(/\b(Bearer|Basic)\s+[a-z\d+/_=.~-]+/gi, '$1 [redacted]')
            .replace(/((?:^|\s)--?(?:password|session-token|access-token|otp|authorization)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, '$1[redacted]')
            .replace(/\b[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,}\b/gi, '[redacted email]');
        // A value cannot inject a second apparent Homebridge record or terminal
        // escape. Redaction happens first so multiline credentials are removed.
        output = output.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, ' ')
            .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
        return output.length > MAX_MESSAGE_LENGTH ? output.slice(0, MAX_MESSAGE_LENGTH) + ' [truncated]' : output;
    }
    formatMessage(message, device) {
        let formatted = '';
        if (device) {
            formatted += '[' + safeText(device) + '] ';
        }
        formatted += safeText(message);
        return this.redact(formatted);
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
    diagnostic(event, fields = {}, device) {
        if (!this.debugMode) return;
        try {
            const message = formatDiagnostic(event, fields, ++this.diagnosticSequence);
            // The field formatter permits only public enums, generated local
            // references, structural types, versions, and numeric/boolean
            // metadata. It remains safe and useful after the secret registry
            // fills. Omit the free-form device label in that case, retain all
            // redactions already registered, and make this fallback visible.
            this.log.info(this.redactionSaturated
                ? this.redactText(message) + ' redactionLimited=true'
                : this.formatMessage(message, device));
        } catch (_) { /* Diagnostics must never interrupt camera operation. */ }
    }
}
exports.Logger = Logger;
