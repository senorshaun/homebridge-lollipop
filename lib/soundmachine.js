'use strict';

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
        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, 'Lollipop')
            .setCharacteristic(this.Characteristic.Model, 'Pro 2')
            .setCharacteristic(this.Characteristic.SerialNumber, config.pairingID)
            .setCharacteristic(this.Characteristic.ConfiguredName, accessory.displayName);
        const characteristic = this.accessory.getService(this.Service.Switch).getCharacteristic(this.Characteristic.On);
        characteristic.on('set', this.setOn.bind(this));
        characteristic.on('get', callback => {
            if (!this.isConnected() || this.lastStatus === undefined) return callback(new Error('Camera sound status is unavailable.'));
            callback(null, this.lastStatus);
        });
    }

    isConnected() {
        return !this.stopped && this.connected && this.mqttClient && this.mqttClient.connected;
    }

    setClient(client) {
        this.setConnected(false);
        this.mqttClient = client;
    }

    setConnected(connected) {
        if (this.stopped) return;
        this.connected = connected;
        if (!connected) {
            this.lastStatus = undefined;
            this.finishPending(new Error('Camera MQTT connection is unavailable.'));
        } else {
            this.publishMusicStatus();
        }
    }

    publishMusicStatus() {
        if (!this.isConnected()) return;
        this.mqttClient.publish(this.config.pairingID + '/musicStatus',
            JSON.stringify({ method: 'musicStatus', id: 0 }), { qos: 0, retain: false }, error => {
                if (error) this.finishPending(new Error('Could not request camera sound status.'));
            });
    }

    updateOn(status) {
        if (!this.isConnected() || !Object.prototype.hasOwnProperty.call(STATUS, status)) return;
        const active = STATUS[status];
        this.lastStatus = active;
        this.accessory.getService(this.Service.Switch).getCharacteristic(this.Characteristic.On).updateValue(active);
        if (this.pending && this.pending.active === active) this.finishPending();
    }

    controlResult(result) {
        if (!this.pending || !this.pending.written || !result) return;
        if (result.status !== 1) {
            this.finishPending(new Error('The camera rejected the sound command.'));
        } else {
            this.publishMusicStatus();
        }
    }

    setOn(active, callback) {
        if (typeof callback !== 'function') return;
        if (!this.isConnected()) return callback(new Error('Camera MQTT connection is unavailable.'));
        if (typeof active !== 'boolean') return callback(new Error('Invalid sound switch value.'));
        if (this.pending) return callback(new Error('Wait for the camera to confirm the current sound command.'));
        const pending = { active, callback };
        this.pending = pending;
        pending.timer = setTimeout(() => {
            if (this.pending === pending) this.finishPending(new Error('The camera did not confirm the sound command.'));
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
                if (error) this.finishPending(new Error('Could not send the camera sound command.'));
                else {
                    pending.written = true;
                    this.publishMusicStatus();
                }
            });
    }

    finishPending(error) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.callback(error || null);
    }

    getCountdownTimer(seconds) {
        if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) this.countdownTimer = seconds;
    }

    shutdown() {
        this.setConnected(false);
        this.stopped = true;
    }
};
