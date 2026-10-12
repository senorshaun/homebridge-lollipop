"use strict";

const path = require('path');
const { Logger } = require('./lib/logger');
const { emitDiagnostic } = require('./lib/diagnostics');
const Lollipop = require('./lib/lollipop');
const { LollipopAccount } = require('./lib/lollipopAccount');
const { resolveCameraConnection, hasDirectStreamConfig } = require('./lib/cameraConnection');
const { createAuthenticatedMqttOptions } = require('./lib/mqttAuth');
const PLUGIN_NAME = 'homebridge-lollipop';
const PLATFORM_NAME = 'Lollipop';
const REFRESH_INTERVAL = 5 * 60 * 1000;

module.exports = homebridge => {
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LollipopPlatform);
};

class LollipopPlatform {
    constructor(log, config, api) {
        this.accessories = {};
        this.cameras = new Map();
        this.api = api;
        this.config = config || {};
        this.log = new Logger(log, this.config.debug);
        this.accountMode = !!(this.config.account && Object.values(this.config.account).some(Boolean));
        this.cameraReferences = new Map();
        let mqttVersion;
        try { mqttVersion = require('mqtt/package.json').version; } catch (_) { /* Optional diagnostic metadata. */ }
        emitDiagnostic(this.log, 'platform.start', {
            diagnosticsVersion: 1, pluginVersion: require('./package.json').version,
            nodeVersion: process.version, opensslVersion: process.versions && process.versions.openssl,
            homebridgeVersion: api.serverVersion || api.version, mqttVersion,
            platform: process.platform, arch: process.arch,
            mode: this.accountMode ? 'account' : 'manual', cameraCount: (this.config.lollipops || []).length
        });
        if (!this.accountMode && !(this.config.lollipops || []).length) {
            this.log.warn('Sign in to a Lollipop account in plugin settings, or configure a camera manually.');
            this.disabled = true;
        }
        this.api.on('didFinishLaunching', () => {
            if (!this.disabled && !this.stopped) this.didFinishLaunching();
        });
        this.api.on('shutdown', () => {
            this.stopped = true;
            emitDiagnostic(this.log, 'platform.refresh', { phase: 'cancelled', reason: 'shutdown' });
            clearTimeout(this.refreshTimer);
            if (this.account && this.account.close) this.account.close();
        });
    }

    didFinishLaunching() {
        if (this.disabled || this.stopped) return;
        if (this.accountMode) return this.refreshAccount();
        for (const config of this.config.lollipops || []) this.setupManualCamera(config);
    }

    setupManualCamera(config) {
        if (!config || !config.name) {
            this.log.error('One of your lollipops has no name configured. This lollipop will be skipped.');
            return;
        }
        if (!config.ip && !config.rtspUrl) {
            this.log.error('No authenticated RTSP URL or camera IP address specified. This lollipop will be skipped.', config.name);
            return;
        }
        if (hasDirectStreamConfig(config)) {
            try { resolveCameraConnection(config); }
            catch (error) {
                this.log.error('Camera configuration invalid: ' + error.message, config.name);
                return;
            }
        }
        this.addCamera(config, this.api.hap.uuid.generate(config.name + ' Camera'));
    }

    addCamera(config, uuid, accountConnection) {
        if (this.cameras.has(uuid) || this.stopped) return this.cameras.get(uuid);
        const cached = this.accessories[uuid];
        const accessory = cached || new this.api.platformAccessory(config.name, uuid);
        this.accessories[uuid] = accessory;
        accessory.existsInConfig = true;
        accessory.context = accessory.context || {};
        if (accountConnection) accessory.context.lollipopCameraId = config.cameraId;
        this.log.info(cached ? 'Loading cached lollipop.' : 'Configuring lollipop...', accessory.displayName);
        config = { ...config, debug: this.log.debugMode || config.debug === true };
        const camera = new Lollipop(this.log, config, accessory, this.api, this.accessories, accountConnection);
        this.cameras.set(uuid, camera);
        if (!cached) {
            if (config.unbridge) {
                this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
                this.log.info('Camera added as an external accessory. Pair it in the Home app.', accessory.displayName);
            } else {
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        } else if (this.api.updatePlatformAccessories) {
            this.api.updatePlatformAccessories([accessory]);
        }
        return camera;
    }

    cameraReference(cameraId) {
        if (this.account && typeof this.account.cameraReference === 'function') return this.account.cameraReference(cameraId);
        if (!this.cameraReferences.has(cameraId)) this.cameraReferences.set(cameraId, 'camera-' + (this.cameraReferences.size + 1));
        return this.cameraReferences.get(cameraId);
    }

    async refreshAccount(forceCredentialId, reason = forceCredentialId ? 'authentication' : 'startup') {
        if (this.refreshing || this.stopped) {
            emitDiagnostic(this.log, 'platform.refresh', { phase: 'skipped', reason: this.stopped ? 'shutdown' : 'busy' });
            return;
        }
        const started = Date.now();
        emitDiagnostic(this.log, 'platform.refresh', { phase: 'start', reason });
        this.refreshing = true;
        clearTimeout(this.refreshTimer);
        let retry = true;
        try {
            if (!this.account) {
                if (!this.api.user || typeof this.api.user.storagePath !== 'function') {
                    throw new Error('Homebridge did not provide its storage directory.');
                }
                this.account = new LollipopAccount({
                    ...this.config.account,
                    storagePath: path.join(this.api.user.storagePath(), 'lollipop'),
                    diagnostics: (event, fields) => emitDiagnostic(this.log, event, fields),
                    registerSecrets: values => this.log.addSecrets(values)
                });
            }
            await this.account.authenticate();
            const records = await this.account.listCameras();
            if (this.stopped) return;
            if (!Array.isArray(records)) throw new Error('Lollipop returned an invalid camera list.');
            const wanted = new Set();
            const seenNames = new Set();
            const overrides = this.config.lollipops || [];
            for (const record of records) {
                if (this.stopped) return;
                const override = this.cameraOverride(record, records, overrides);
                const cached = this.findAccountAccessory(record.cameraId);
                const cameraRef = this.cameraReference(record.cameraId);
                this.log.addSecrets([record.cameraId, record.ip, record.rtspUrl]);
                emitDiagnostic(this.log, 'platform.camera', {
                    phase: 'selected', cameraRef, cached: !!cached,
                    enabled: override.enabled !== false, hasAddress: !!record.ip
                });
                if (override.enabled === false) continue;
                const name = override.name || (cached && cached.displayName) || record.name || 'Lollipop';
                const fallbackName = seenNames.has(name) ? name + ' ' + (seenNames.size + 1) : name;
                seenNames.add(fallbackName);
                const config = {
                    audio: true, enableSoundMachine: true, movementSensitivity: 10,
                    rtspUrl: record.rtspUrl,
                    ...this.config.cameraDefaults, ...override,
                    name: fallbackName, cameraId: record.cameraId, ip: record.ip,
                    pairingID: record.cameraId, accountMode: true, hksv: false,
                    diagnosticRef: cameraRef, debug: this.log.debugMode
                };
                const uuid = cached ? cached.UUID : this.accountUuid(record.cameraId, fallbackName);
                wanted.add(uuid);
                const legacySoundUuid = this.api.hap.uuid.generate(fallbackName + ' Sound Machine');
                const soundUuid = (cached && cached.context && cached.context.lollipopSoundUuid)
                    || (this.accessories[legacySoundUuid] ? legacySoundUuid : this.api.hap.uuid.generate('Lollipop account sound:' + record.cameraId));
                config.soundMachineUuid = soundUuid;
                if (config.enableSoundMachine) wanted.add(soundUuid);
                if (!record.ip) {
                    emitDiagnostic(this.log, 'platform.camera', { phase: 'missing_address', cameraRef });
                    this.log.warn('The account has not supplied a local camera address yet. Waiting for the camera to come online.', fallbackName);
                    continue;
                }
                try { resolveCameraConnection(config); }
                catch (_) {
                    emitDiagnostic(this.log, 'platform.camera', { phase: 'skipped', cameraRef, reason: 'invalid_response' });
                    this.log.error('The account camera does not have usable local streaming settings.', fallbackName);
                    continue;
                }
                let credentials;
                let authorizationError;
                try {
                    credentials = await this.account.getMqttCredentials(record.cameraId, { force: forceCredentialId === record.cameraId });
                    createAuthenticatedMqttOptions({ cameraId: record.cameraId, ...credentials });
                } catch (error) {
                    credentials = undefined;
                    emitDiagnostic(this.log, 'platform.camera', {
                        phase: 'failed', operation: 'credentials', cameraRef, code: error && error.code
                    });
                    if (['INVALID_SESSION', 'SIGN_IN_REQUIRED'].includes(error && error.code)) authorizationError = error;
                    else if (error && error.code === 'ACCESS_DENIED') this.log.warn('The account cannot provide MQTT access to this camera. Check camera-owner access in the Lollipop app.', fallbackName);
                    else this.log.warn('MQTT credentials are unavailable. Video can still start; sound controls will retry after the next account refresh.', fallbackName);
                }
                if (this.stopped) return;
                const existing = this.cameras.get(uuid);
                emitDiagnostic(this.log, 'platform.camera', {
                    phase: existing ? 'updated' : 'configured', cameraRef, mode: 'account',
                    credentialsPresent: !!credentials, audio: config.audio !== false,
                    soundEnabled: !!config.enableSoundMachine, hksv: false
                });
                if (existing) {
                    existing.updateAccountConnection(config, credentials);
                } else {
                    this.addCamera(config, uuid, {
                        credentials,
                        onAuthenticationFailure: () => this.refreshRejectedCredentials(record.cameraId)
                    });
                }
                const accessory = this.accessories[uuid];
                if (accessory) {
                    accessory.context.lollipopSoundUuid = soundUuid;
                    if (this.api.updatePlatformAccessories) this.api.updatePlatformAccessories([accessory]);
                }
                if (authorizationError) throw authorizationError;
            }
            // API failures do not pass through this authoritative reconciliation.
            if (this.account.lastCameraSource !== 'cache') this.removeMissingAccountAccessories(wanted);
            if (!this.didDiscover) {
                this.log.info('Discovered ' + records.length + ' Lollipop camera(s); configuring local video and MQTT.');
                this.didDiscover = true;
            }
            emitDiagnostic(this.log, 'platform.refresh', {
                phase: 'complete', reason, cameraCount: records.length,
                source: this.account.lastCameraSource === 'cache' ? 'cache' : 'cloud', durationMs: Date.now() - started
            });
        } catch (error) {
            const code = error && error.code;
            emitDiagnostic(this.log, 'platform.refresh', { phase: 'failed', reason, code, durationMs: Date.now() - started });
            retry = !['OTP_REQUIRED', 'SIGN_IN_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_SESSION', 'INVALID_ACCOUNT', 'ACCESS_DENIED'].includes(code);
            const message = code === 'OTP_REQUIRED'
                ? 'Finish email-code verification in the Lollipop plugin settings, then restart the child bridge.'
                : !retry
                    ? 'Sign in again in the Lollipop plugin settings, then restart the child bridge.'
                    : 'Lollipop account discovery is unavailable. Existing local connections will continue and discovery will retry.';
            this.log.error(message);
        } finally {
            this.refreshing = false;
            if (!this.stopped && retry) {
                emitDiagnostic(this.log, 'platform.refresh', { phase: 'scheduled', reason: 'periodic', delayMs: REFRESH_INTERVAL });
                this.refreshTimer = setTimeout(() => this.refreshAccount(undefined, 'periodic'), REFRESH_INTERVAL);
                this.refreshTimer.unref?.();
            }
        }
    }

    cameraOverride(record, records, overrides) {
        const explicit = overrides.find(config => config.cameraId === record.cameraId)
            || overrides.find(config => config.accountCameraName === record.name)
            || overrides.find(config => !config.cameraId && !config.accountCameraName && config.name === record.name);
        if (explicit) return explicit;
        if (records.length === 1 && overrides.length === 1 && !overrides[0].cameraId && !overrides[0].accountCameraName) return overrides[0];
        return {};
    }

    findAccountAccessory(cameraId) {
        return Object.values(this.accessories).find(accessory => {
            if (accessory.context && accessory.context.lollipopCameraId === cameraId && !accessory.context.lollipopSound) return true;
            const information = accessory.getService(this.api.hap.Service.AccessoryInformation);
            const serial = information && information.getCharacteristic(this.api.hap.Characteristic.SerialNumber).value;
            return serial === cameraId && !accessory.getService(this.api.hap.Service.Switch);
        });
    }

    accountUuid(cameraId, name) {
        const legacyUuid = this.api.hap.uuid.generate(name + ' Camera');
        const cached = this.accessories[legacyUuid];
        if (cached && !(cached.context && cached.context.lollipopCameraId)) return legacyUuid;
        return this.api.hap.uuid.generate('Lollipop account camera:' + cameraId);
    }

    refreshRejectedCredentials(cameraId) {
        if (this.stopped || this.refreshing) return;
        this.lastCredentialRetry = this.lastCredentialRetry || new Map();
        const last = this.lastCredentialRetry.get(cameraId) || 0;
        if (Date.now() - last < REFRESH_INTERVAL) {
            emitDiagnostic(this.log, 'platform.refresh', {
                phase: 'skipped', reason: 'rate_limited', cameraRef: this.cameraReference(cameraId),
                delayMs: REFRESH_INTERVAL - (Date.now() - last)
            });
            return;
        }
        this.lastCredentialRetry.set(cameraId, Date.now());
        this.refreshAccount(cameraId);
    }

    removeMissingAccountAccessories(wanted) {
        for (const [uuid, accessory] of Object.entries(this.accessories)) {
            if (wanted.has(uuid)) continue;
            const camera = this.cameras.get(uuid);
            emitDiagnostic(this.log, 'platform.camera', {
                phase: 'removed', cameraRef: camera && camera.config.diagnosticRef
            });
            if (camera) camera.shutdown();
            this.cameras.delete(uuid);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            delete this.accessories[uuid];
            this.log.info('Removed a camera or sound switch that is no longer selected.');
        }
    }

    configureAccessory(accessory) {
        if (this.accountMode) {
            this.accessories[accessory.UUID] = accessory;
            return;
        }
        const selected = (this.config.lollipops || []).some(config =>
            accessory.UUID === this.api.hap.uuid.generate(config.name + ' Camera') ||
            (accessory.UUID === this.api.hap.uuid.generate(config.name + ' Sound Machine') && config.enableSoundMachine));
        if (selected) {
            accessory.existsInConfig = true;
            this.accessories[accessory.UUID] = accessory;
        } else {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.log.info('Deleted removed lollipop or accessory.');
        }
    }
}
