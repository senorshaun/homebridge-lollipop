let Characteristic, Service, statusMap;
const mqtt = require("mqtt");

module.exports = class SoundMachine {

    constructor(log, config, accessory, homebridge, mqttClient) {
        Characteristic = homebridge.hap.Characteristic;
        Service = homebridge.hap.Service;
        this.accessory = accessory;
        this.log = log;
        this.config = config;
        this.homebridge = homebridge;
        this.mqttClient = mqttClient;
        this.countdownTimer;
        statusMap = {
            play: true,
            stop: false,
            pause: false
        }

        this.accessory
            .getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Manufacturer, "Lollipop")
                .setCharacteristic(Characteristic.Model, 'Pro 2')
                .setCharacteristic(Characteristic.SerialNumber, this.config.pairingID)
                .setCharacteristic(Characteristic.ConfiguredName, this.accessory.displayName);

        this.accessory.getService(Service.Switch).getCharacteristic(Characteristic.On).on('set', this.setOn.bind(this));

        this.publishMusicStatus();
    }

    publishMusicStatus() {
        this.mqttClient.publish(
            this.config.pairingID + '/musicStatus',
            `{"method":"musicStatus", "id":1}`);
    }

    updateOn(active) {
        if (statusMap[active] != this.accessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value) {
            this.log.info("Set to " + active, this.accessory.displayName);
        }
        this.accessory
            .getService(Service.Switch)
                .getCharacteristic(Characteristic.On)
                    .updateValue(statusMap[active]);
    }

    setOn(active, callback) {
        let mappedActive = Object.keys(statusMap).find(key => statusMap[key] === active);
        this.log.info("Trying to set to " + mappedActive, this.accessory.displayName);
        this.mqttClient.publish(
            this.config.pairingID + '/controlMusic',
            `{"method":"controlMusic", "params": {"playStatus": "${mappedActive}", "countdownTimer": ${this.countdownTimer || 86400}}, "id":17}`);
        callback(null);
    } 

    getCountdownTimer(seconds) {
        this.countdownTimer = seconds;
    }    
}