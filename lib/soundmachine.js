'use strict';
const { emitDiagnostic } = require('./diagnostics');

const STATUS = Object.freeze({ play: true, stop: false, pause: false });
const COMMAND_TIMEOUT = 8000;

module.exports = class SoundMachine {
    constructor(log, config, accessory, homebridge, mqttClient) {
        this.Characteristic = homebridge.hap.Characteristic;
        this.Service = homebridge.hap.Service;
        this.accessory = accessory;
        this.log = log;
        this.config = config;
        this.mqttClient = mqttClient;
        this.connected = false;
        this.nextCommandId = 0;
        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, 'Lollipop')
            .setCharacteristic(this.Characteristic.Model, 'Pro 2')
            .setCharacteristic(this.Characteristic.SerialNumber, config.pairingID)
            .setCharacteristic(this.Characteristic.ConfiguredName, accessory.displayName);
        this.configureMusicName(homebridge);
        const characteristic = this.accessory.getService(this.Service.Switch).getCharacteristic(this.Characteristic.On);
        characteristic.on('set', this.setOn.bind(this));
        characteristic.on('get', callback => {
            if (!this.isConnected() || this.lastStatus === undefined) return callback(new Error('Camera sound status is unavailable.'));
            callback(null, this.lastStatus);
        });
    }

    configureMusicName(homebridge) {
        if (typeof this.config.name !== 'string' || !this.config.name.trim()) return;
        const name = this.config.name + ' Music';
        const context = this.accessory.context || (this.accessory.context = {});
        const defaults = new Set([
            this.config.name, this.config.name + ' Sound Machine', name, context.lollipopMusicName
        ]);
        let changed = false;
        if (!this.accessory.displayName || defaults.has(this.accessory.displayName)) {
            changed = this.accessory.displayName !== name;
            this.accessory.displayName = name;
        }
        const service = this.accessory.getService(this.Service.Switch);
        if (!service.displayName || defaults.has(service.displayName)) {
            if (service.displayName !== name) changed = true;
            service.displayName = name;
        }
        for (const type of [this.Characteristic.Name, this.Characteristic.ConfiguredName]) {
            if (!type) continue;
            if (type === this.Characteristic.ConfiguredName && service.testCharacteristic &&
                !service.testCharacteristic(type)) service.addOptionalCharacteristic?.(type);
            const current = service.getCharacteristic(type).value;
            // Do not overwrite a name the tester has already chosen in HomeKit.
            if (!current || defaults.has(current)) {
                service.setCharacteristic(type, name);
                if (current !== name) changed = true;
            }
        }
        const information = this.accessory.getService(this.Service.AccessoryInformation);
        if (this.Characteristic.Name) information.setCharacteristic(this.Characteristic.Name, this.accessory.displayName);
        information.setCharacteristic(this.Characteristic.ConfiguredName, this.accessory.displayName);
        context.lollipopMusicName = name;
        // The UUID, service subtype, camera association, and MQTT topics stay
        // unchanged. Persist the label change without unpairing the accessory.
        if (changed) homebridge.updatePlatformAccessories?.([this.accessory]);
    }

    isConnected() {
        return !this.stopped && this.connected && this.mqttClient && this.mqttClient.connected;
    }

    diagnostic(event, fields) {
        emitDiagnostic(this.log, event, { cameraRef: this.config.diagnosticRef, ...fields }, this.accessory.displayName);
    }

    setClient(client) {
        this.setConnected(false);
        this.mqttClient = client;
    }

    setConnected(connected, reason = 'disconnected') {
        if (this.stopped) return;
        if (this.connected !== connected) this.diagnostic('sound.status', {
            phase: connected ? 'connected' : 'offline', connected, knownState: this.lastStatus !== undefined
        });
        this.connected = connected;
        if (!connected) {
            this.lastStatus = undefined;
            this.lastPlayStatus = undefined;
            this.invalidStatusReported = false;
            this.finishPending(new Error('Camera MQTT connection is unavailable.'), reason);
        } else {
            this.publishMusicStatus();
        }
    }

    publishMusicStatus() {
        if (!this.isConnected()) return;
        this.diagnostic('sound.status', {
            phase: 'requested', connected: true, knownState: this.lastStatus !== undefined,
            commandId: this.pending && this.pending.commandId
        });
        this.mqttClient.publish(this.config.pairingID + '/musicStatus',
            JSON.stringify({ method: 'musicStatus', id: 0 }), { qos: 0, retain: false }, error => {
                if (error) {
                    this.diagnostic('sound.status', { phase: 'failed', reason: 'publish_error', code: error.code });
                    this.finishPending(new Error('Could not request camera sound status.'), 'publish_error');
                }
            });
    }

    updateOn(status) {
        if (!this.isConnected()) return;
        if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS, status)) {
            if (!this.invalidStatusReported) this.diagnostic('sound.status', {
                phase: 'ignored', reason: 'invalid_schema', playStatus: 'unknown',
                resultType: status === null ? 'null' : Array.isArray(status) ? 'array' : typeof status
            });
            this.invalidStatusReported = true;
            return;
        }
        this.invalidStatusReported = false;
        const active = STATUS[status];
        if (this.lastPlayStatus !== status || this.pending) this.diagnostic('sound.status', {
            phase: 'received', playStatus: status, connected: true, knownState: true,
            commandId: this.pending && this.pending.commandId
        });
        this.lastPlayStatus = status;
        this.lastStatus = active;
        this.accessory.getService(this.Service.Switch).getCharacteristic(this.Characteristic.On).updateValue(active);
        if (this.pending && this.pending.active === active) this.finishPending();
    }

    controlResult(result) {
        if (!this.pending || !this.pending.written || !result) return;
        if (result.status !== 1) {
            this.finishPending(new Error('The camera rejected the sound command.'), 'camera_rejected');
        } else {
            this.diagnostic('sound.command', {
                phase: 'acknowledged', commandId: this.pending.commandId,
                requestedState: this.pending.active ? 'on' : 'off', durationMs: Date.now() - this.pending.started
            });
            this.publishMusicStatus();
        }
    }

    setOn(active, callback) {
        if (typeof callback !== 'function') return;
        const commandId = ++this.nextCommandId;
        const requestedState = typeof active === 'boolean' ? active ? 'on' : 'off' : undefined;
        this.diagnostic('sound.command', { phase: 'requested', commandId, requestedState, confirmationTimeoutMs: COMMAND_TIMEOUT });
        const reject = (reason, message) => {
            this.diagnostic('sound.command', { phase: 'rejected', commandId, requestedState, reason });
            callback(new Error(message));
        };
        if (!this.isConnected()) return reject('disconnected', 'Camera MQTT connection is unavailable.');
        if (typeof active !== 'boolean') return reject('invalid_input', 'Invalid sound switch value.');
        if (this.pending) return reject('busy', 'Wait for the camera to confirm the current sound command.');
        const pending = { active, callback, commandId, started: Date.now() };
        this.pending = pending;
        pending.timer = setTimeout(() => {
            if (this.pending === pending) this.finishPending(new Error('The camera did not confirm the sound command.'), 'confirmation_timeout');
        }, COMMAND_TIMEOUT);
        pending.timer.unref?.();
        const message = {
            method: 'controlMusic',
            params: {
                playStatus: active ? 'play' : 'pause', countdownTimer: this.countdownTimer || 86400,
                ...(active ? { repeatStatus: 'one' } : {})
            },
            id: 0
        };
        // QoS 0 plus queueQoSZero:false prevents a timed-out switch command from
        // being replayed later when a sleeping/disconnected camera reconnects.
        this.mqttClient.publish(this.config.pairingID + '/controlMusic', JSON.stringify(message),
            { qos: 0, retain: false }, error => {
                if (this.pending !== pending) return;
                if (error) this.finishPending(new Error('Could not send the camera sound command.'), 'publish_error');
                else {
                    pending.written = true;
                    this.diagnostic('sound.command', { phase: 'published', commandId, requestedState, durationMs: Date.now() - pending.started });
                    this.publishMusicStatus();
                }
            });
    }

    finishPending(error, reason) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        this.diagnostic('sound.command', {
            phase: error ? reason === 'confirmation_timeout' ? 'timeout' : 'failed' : 'confirmed',
            commandId: pending.commandId, requestedState: pending.active ? 'on' : 'off',
            reason, durationMs: Date.now() - pending.started
        });
        pending.callback(error || null);
    }

    getCountdownTimer(seconds) {
        if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) this.countdownTimer = seconds;
    }

    shutdown() {
        this.setConnected(false, 'shutdown');
        this.stopped = true;
    }
};
