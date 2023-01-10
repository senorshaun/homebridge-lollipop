let Characteristic, Service, sensors;
const streamingDelegate = require("./streamingDelegate");
let SoundMachine = require("./soundmachine");
const crypto = require('crypto');
const mqtt = require("mqtt");

module.exports = class Lollipop {

    constructor(log, config, accessory, api, accessories) {
        Characteristic = api.hap.Characteristic;
        Service = api.hap.Service;
        this.accessory = accessory;
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = accessories;
        sensors = {
            movementSensor: {
                name: "Movement Sensor",
                service: Service.MotionSensor,
                characteristic: Characteristic.MotionDetected,
                resetTime: 30,
                timer: null
            },
            cryingDetectionSensor: {
                name: "Crying Detection Sensor",
                service: Service.MotionSensor,
                characteristic: Characteristic.MotionDetected,
                resetTime: 60,
                timer: null
            },
            crossingDetectionSensor: {
                name: "Crossing Detection Sensor",
                service: Service.MotionSensor,
                characteristic: Characteristic.MotionDetected,
                resetTime: 60,
                timer: null
            },
            noiseSensor: {
                name: "Noise Sensor",
                service: Service.MotionSensor,
                characteristic: Characteristic.MotionDetected,
                resetTime: 60,
                timer: null
            },
            hksvSensor: {
                name: "HKSV Sensor",
                service: Service.MotionSensor,
                characteristic: Characteristic.MotionDetected,
                resetTime: 60,
                timer: null
            },
        };

        // define sensor type
        if (this.config.contactSensors) {
            sensors.movementSensor.service = Service.ContactSensor;
            sensors.movementSensor.characteristic = Characteristic.ContactSensorState;
            sensors.cryingDetectionSensor.service = Service.ContactSensor;
            sensors.cryingDetectionSensor.characteristic = Characteristic.ContactSensorState;
            sensors.crossingDetectionSensor.service = Service.ContactSensor;
            sensors.crossingDetectionSensor.characteristic = Characteristic.ContactSensorState;
            sensors.noiseSensor.service = Service.ContactSensor;
            sensors.noiseSensor.characteristic = Characteristic.ContactSensorState;
        }

        this.initializeLollipop();
    }

    initializeLollipop() {
        this.log.debug('Setting up MQTT connection only to determine pairingID...', this.accessory.displayName);
        const client = mqtt.connect('mqtts://' + this.config.ip + ':1883', {
            rejectUnauthorized: false
        });
        client.on('connect', () => {
            this.log.debug('MQTT connected intially', this.accessory.displayName);
            client.subscribe('#');
        });
        client.on('message', (topic, message) => {
            var splitTopic = topic.split('/');
            this.log.info('PairingID found: ' + splitTopic[0], this.accessory.displayName);
            this.log.info('Continuing with camera setup', this.accessory.displayName)
            this.config.pairingID = splitTopic[0];
            this.setupLollipop();
            client.unsubscribe('#');
            client.end();
        });
    }

    setupLollipop() {
        // set up the information
        this.accessory.on("identify", () => {
            this.log.info('Identify requested.', this.accessory.displayName);
        });
        const accInfo = this.accessory.getService(Service.AccessoryInformation);
        if (accInfo) {
            accInfo.setCharacteristic(Characteristic.Manufacturer, 'Lollipop');
            accInfo.setCharacteristic(Characteristic.Model, 'Pro 2');
            accInfo.setCharacteristic(Characteristic.SerialNumber, this.config.pairingID);
            this.accessory.firmwareNeeded = true;
        }
        this.accessory.category = this.api.hap.Categories.IP_CAMERA;
        
        // set up the camera controller and video stream
        const pairingIDHash = crypto.createHash('md5').update(this.config.pairingID).digest('hex');
        this.config.source = "-rtsp_transport tcp -re -i rtsp://" + this.config.ip + ":554/live/" + pairingIDHash + "/ch00_0";
        this.config.audio = true;
        //this.config.returnAudioTarget = true;
        this.config.prebuffer = this.config.hksv;

        this.log.debug('Creating camera stream', this.accessory.displayName);
        const delegate = new streamingDelegate.StreamingDelegate(this.log, this.config, this.api, this.accessory);
        this.accessory.configureController(delegate.controller);
        
        // set up the mqtt connection to use for statusing
        this.log.debug('Setting up MQTT connection', this.accessory.displayName);
        this.accessory.client = mqtt.connect('mqtts://' + this.config.ip + ':1883', {
            rejectUnauthorized: false
        });
        this.accessory.client.on('connect', () => {
            this.log.debug('MQTT connected.', this.accessory.displayName);
            this.accessory.client.subscribe([this.config.pairingID + '/liveNote',
                                            this.config.pairingID + '/prenotify',
                                            //this.config.pairingID + '/cameraStatus/return',
                                            this.config.pairingID + '/musicStatus/return']);
            this.api.on("SIGTERM", () => {
                this.accessory.client.unsubscribe('#');
                this.accessory.client.end();
            });
        });
        this.accessory.client.on('message', (topic, message) => {
            var splitTopic = topic.split('/');
            switch (splitTopic[1]) {
                case 'liveNote':
                    this.liveNoteHandler(message);
                    break;
                case 'prenotify':
                    this.prenotifyHandler(message);
                    break;
                case 'cameraStatus':
                    this.cameraStatusHandler(message);
                    break;
                case 'musicStatus':
                    this.musicStatusHandler(message);
                    break;
            }
        });
        
        // initialize movement sensor attached to camera
        this.initializeSensor(this.config.movementSensitivity, sensors.movementSensor);

        // initialize crying detection sensor attached to camera 
        this.initializeSensor(this.config.enableCryingDetectionSensor, sensors.cryingDetectionSensor);

        // initialize crossing detection sensor attached to camera 
        this.initializeSensor(this.config.enableCrossingDetectionSensor, sensors.crossingDetectionSensor);

        // initialize noise sensor attached to camera 
        this.initializeSensor(this.config.enableNoiseSensor, sensors.noiseSensor)

        // initialize a motion sensor for hksv
        this.initializeSensor(this.config.hksv, sensors.hksvSensor);

        // initialize sound machine
        this.initializeSoundMachine(this.config.enableSoundMachine, this.accessory.client);
    }

    initializeSensor(configSetting, sensor) {
        const thisSensor = this.accessory.getService(sensor.name);
        if (configSetting && configSetting > 0) {
            if (!thisSensor) {
                this.log.debug('Creating ' + sensor.name, this.accessory.displayName);
                this.accessory.addService(sensor.service, sensor.name, sensor.name);
            }
        } else if (thisSensor) {
            this.log.debug(sensor.name + ' found but not enabled. Removing.', this.accessory.displayName);
            this.accessory.removeService(thisSensor);
        }
    }

    initializeSoundMachine(configSetting, mqttClient){
        var uuid = this.api.hap.uuid.generate(this.config.name + ' Sound Machine');
        // look to see if it is already cached
        let thisSoundMachine = this.accessories[uuid];
        if (configSetting) {
            this.log.info('Configuring sound machine...', this.accessory.displayName);
            if (!thisSoundMachine) {
                // create accessory if it isn't
                thisSoundMachine = new this.api.platformAccessory(this.config.name + ' Sound Machine', uuid, this.api.hap.Categories.SPEAKER);
                let deviceService = thisSoundMachine.addService(Service.Switch, thisSoundMachine.displayName);
                this.api.registerPlatformAccessories('homebridge-lollipop', 'Lollipop', [thisSoundMachine]);
            }
            this.soundMachine= new SoundMachine(this.log, this.config, (thisSoundMachine instanceof SoundMachine ?  thisSoundMachine.accessory :  thisSoundMachine), this.api, mqttClient);
        } else if (thisSoundMachine) {
            this.log.info('Found sound machine that is not configued. Removing.', this.accessory.displayName);
            this.api.unregisterPlatformAccessories('homebridge-lollipop', 'Lollipop', [thisAccessory]);
        }
    }

    liveNoteHandler(message) {
        const parsedJSON = JSON.parse(message);
        if (parsedJSON.result && parsedJSON.result.motion >= (this.config.movementSensitivity || 100)) {
            this.log.debug('liveNote message: ' + message, this.accessory.displayName);
            this.sensorHandler(true, sensors.movementSensor);
            sensors.hksvSensor.resetTime = sensors.movementSensor.resetTime;
            this.sensorHandler(true, sensors.hksvSensor);
        }
    }

    prenotifyHandler(message) {
        this.log.debug('prenotify message: ' + message, this.accessory.displayName);
        const parsedJSON = JSON.parse(message);
        switch(parsedJSON.param.event_params[0].event_type) {
            case 1:
                this.sensorHandler(true, sensors.cryingDetectionSensor);
                sensors.hksvSensor.resetTime = sensors.cryingDetectionSensor.resetTime;
                this.sensorHandler(true, sensors.hksvSensor);
                break;
            case 2:
                this.sensorHandler(true, sensors.crossingDetectionSensor);
                sensors.hksvSensor.resetTime = sensors.crossingDetectionSensor.resetTime;
                this.sensorHandler(true, sensors.hksvSensor);
                break;
            case 3:
                this.sensorHandler(true, sensors.noiseSensor);
                sensors.hksvSensor.resetTime = sensors.noiseSensor.resetTime;
                this.sensorHandler(true, sensors.hksvSensor);
                break;
        }

    }

    cameraStatusHandler(message) {
        this.log.debug('cameraStatus message: ' + message, this.accessory.displayName);
        message = message.slice(2);
        const parsedJSON = JSON.parse(message);
        if (parsedJSON[1].result) {
            if (parsedJSON[1].result.firmwareVersion && this.accessory.firmwareNeeded) {
                this.accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, parsedJSON[1].result.firmwareVersion);
                this.accessory.firmwareNeeded = false;
            }
        }
    }

    musicStatusHandler(message) {
        this.log.debug('musicStatus message: ' + message, this.accessory.displayName);
        message = message.slice(2);
        const parsedJSON = JSON.parse(message);
        if (parsedJSON[1].result) {
            if (this.soundMachine) {
                //this.soundMachine.updateVolume(parsedJSON[1].result.volume);
                this.soundMachine.updateOn(parsedJSON[1].result.playStatus);
                this.soundMachine.getCountdownTimer(parsedJSON[1].result.countdownTimer);
            }
        }
    }

    sensorHandler(active, sensor) {
    const thisSensor = this.accessory.getService(sensor.name);
        if (thisSensor) {
            if (active != this.accessory.getService(sensor.name).value) {
                this.log.debug('Switching ' + sensor.name + (active ? ' on.' : ' off.'), this.accessory.displayName);
            }
            let timeout = sensor.timer;
            if (timeout) {
                clearTimeout(timeout);
                sensor.timer = null;
            }
            if (active) {
                thisSensor.updateCharacteristic(sensor.characteristic, true);
                const timer = setTimeout(() => {
                    this.log.debug(sensor.name + ' handler timeout. Turning off sensor', this.accessory.displayName);
                    sensor.timer = null;
                    thisSensor.updateCharacteristic(sensor.characteristic, false);
                }, sensor.resetTime * 1000);
                sensor.timer = timer;
            } else {
                thisSensor.updateCharacteristic(sensor.characteristic, false);
            }
        }
    }
}