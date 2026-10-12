let Characteristic, Service;
const streamingDelegate = require("./streamingDelegate");
let SoundMachine = require("./soundmachine");
const crypto = require('crypto');
const mqtt = require("mqtt");
const { resolveCameraConnection, hasDirectStreamConfig } = require('./cameraConnection');

module.exports = class Lollipop {

    constructor(log, config, accessory, api, accessories) {
        Characteristic = api.hap.Characteristic;
        Service = api.hap.Service;
        this.accessory = accessory;
        this.log = log;
        this.config = { ...config };
        this.api = api;
        this.accessories = accessories;
        this.sensors = {
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
            this.sensors.movementSensor.service = Service.ContactSensor;
            this.sensors.movementSensor.characteristic = Characteristic.ContactSensorState;
            this.sensors.cryingDetectionSensor.service = Service.ContactSensor;
            this.sensors.cryingDetectionSensor.characteristic = Characteristic.ContactSensorState;
            this.sensors.crossingDetectionSensor.service = Service.ContactSensor;
            this.sensors.crossingDetectionSensor.characteristic = Characteristic.ContactSensorState;
            this.sensors.noiseSensor.service = Service.ContactSensor;
            this.sensors.noiseSensor.characteristic = Characteristic.ContactSensorState;
        }

        this.initializeLollipop();
    }

    initializeLollipop() {
        this.api.on('shutdown', () => this.shutdown());
        if (hasDirectStreamConfig(this.config)) {
            try {
                const connection = resolveCameraConnection(this.config);
                this.directStream = true;
                this.config.ip = connection.ip;
                this.config.pairingID = connection.pairingID || this.accessory.UUID || this.config.name;
                this.config.source = connection.source;
                this.config.hksv = false;
                this.config.prebuffer = false;
                this.config.enableSoundMachine = false;
                this.config.movementSensitivity = 0;
                this.config.enableCryingDetectionSensor = false;
                this.config.enableCrossingDetectionSensor = false;
                this.config.enableNoiseSensor = false;
            } catch (error) {
                this.log.error('Camera configuration invalid: ' + error.message, this.accessory.displayName);
                return;
            }
            this.log.info('Using authenticated RTSP. MQTT sensors, sound controls, and event recording are unavailable in this mode.', this.accessory.displayName);
            this.setupLollipop();
            return;
        }
        if (typeof this.config.pairingID === 'string' && this.config.pairingID) {
            this.setupLollipop();
            return;
        }
        this.log.debug('Setting up MQTT connection only to determine pairingID...', this.accessory.displayName);
        const client = mqtt.connect(this.mqttUrl(), {
            rejectUnauthorized: false,
            reconnectPeriod: 0,
            connectTimeout: 15000
        });
        this.discoveryClient = client;
        let finished = false;
        this.finishDiscovery = () => {
            if (finished) return false;
            finished = true;
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = undefined;
            this.discoveryClient = undefined;
            client.end(true);
            return true;
        };
        const fail = () => {
            if (this.finishDiscovery()) {
                this.log.error('MQTT discovery failed. Configure the camera pairing ID as cameraId, or supply its authenticated RTSP URL.', this.accessory.displayName);
            }
        };
        this.discoveryTimer = setTimeout(fail, 15000);
        this.discoveryTimer.unref?.();
        client.on('error', fail);
        client.on('connect', () => {
            if (finished) return;
            this.log.debug('MQTT connected intially', this.accessory.displayName);
            client.subscribe('#');
        });
        client.on('message', (topic, message) => {
            if (finished) return;
            var splitTopic = topic.split('/');
            if (splitTopic.length < 2 || !splitTopic[0] || splitTopic[0].startsWith('$')) return;
            this.finishDiscovery();
            this.log.info('PairingID found: ' + splitTopic[0], this.accessory.displayName);
            this.log.info('Continuing with camera setup', this.accessory.displayName)
            this.config.pairingID = splitTopic[0];
            this.setupLollipop();
        });
    }

    mqttUrl() {
        const host = this.config.ip.includes(':') && !this.config.ip.startsWith('[') ? '[' + this.config.ip + ']' : this.config.ip;
        return 'mqtts://' + host + ':1883';
    }

    shutdown() {
        this.stopped = true;
        if (this.finishDiscovery) this.finishDiscovery();
        if (this.accessory.client) this.accessory.client.end(true);
        for (const sensor of Object.values(this.sensors)) {
            clearTimeout(sensor.timer);
            sensor.timer = null;
        }
    }

    setupLollipop() {
        if (this.initialized || this.stopped) return;
        this.initialized = true;
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
        if (!this.directStream) {
            const pairingIDHash = crypto.createHash('md5').update(this.config.pairingID).digest('hex');
            const host = this.config.ip.includes(':') && !this.config.ip.startsWith('[') ? '[' + this.config.ip + ']' : this.config.ip;
            this.config.source = "-rtsp_transport tcp -re -i rtsp://" + host + ":554/live/" + pairingIDHash + "/ch00_0";
        }
        this.config.audio = this.config.audio !== false;
        //this.config.returnAudioTarget = true;
        this.config.prebuffer = this.config.hksv;

        this.log.debug('Creating camera stream', this.accessory.displayName);
        const delegate = new streamingDelegate.StreamingDelegate(this.log, this.config, this.api, this.accessory);
        this.accessory.configureController(delegate.controller);

        if (this.directStream) {
            for (const sensor of Object.values(this.sensors)) this.initializeSensor(false, sensor);
            this.initializeSoundMachine(false);
            return;
        }
        
        // set up the mqtt connection to use for statusing
        this.log.debug('Setting up MQTT connection', this.accessory.displayName);
        this.accessory.client = mqtt.connect(this.mqttUrl(), {
            rejectUnauthorized: false
        });
        this.accessory.client.on('error', () => {
            if (!this.mqttErrorReported) {
                this.log.error('MQTT status connection failed. Camera sensors and sound controls are unavailable.', this.accessory.displayName);
                this.mqttErrorReported = true;
            }
        });
        this.accessory.client.on('connect', () => {
            this.mqttErrorReported = false;
            this.log.debug('MQTT connected.', this.accessory.displayName);
            this.accessory.client.subscribe([this.config.pairingID + '/liveNote',
                                            this.config.pairingID + '/prenotify',
                                            //this.config.pairingID + '/cameraStatus/return',
                                            this.config.pairingID + '/musicStatus/return']);
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
        this.initializeSensor(this.config.movementSensitivity, this.sensors.movementSensor);

        // initialize crying detection sensor attached to camera 
        this.initializeSensor(this.config.enableCryingDetectionSensor, this.sensors.cryingDetectionSensor);

        // initialize crossing detection sensor attached to camera 
        this.initializeSensor(this.config.enableCrossingDetectionSensor, this.sensors.crossingDetectionSensor);

        // initialize noise sensor attached to camera 
        this.initializeSensor(this.config.enableNoiseSensor, this.sensors.noiseSensor)

        // initialize a motion sensor for hksv
        this.initializeSensor(this.config.hksv, this.sensors.hksvSensor);

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
            this.api.unregisterPlatformAccessories('homebridge-lollipop', 'Lollipop', [thisSoundMachine]);
            delete this.accessories[uuid];
        }
    }

    liveNoteHandler(message) {
        const parsedJSON = JSON.parse(message);
        if (parsedJSON.result && parsedJSON.result.motion >= (this.config.movementSensitivity || 100)) {
            this.log.debug('liveNote message: ' + message, this.accessory.displayName);
            this.sensorHandler(true, this.sensors.movementSensor);
            this.sensors.hksvSensor.resetTime = this.sensors.movementSensor.resetTime;
            this.sensorHandler(true, this.sensors.hksvSensor);
        }
    }

    prenotifyHandler(message) {
        this.log.debug('prenotify message: ' + message, this.accessory.displayName);
        const parsedJSON = JSON.parse(message);
        switch(parsedJSON.param.event_params[0].event_type) {
            case 1:
                this.sensorHandler(true, this.sensors.cryingDetectionSensor);
                this.sensors.hksvSensor.resetTime = this.sensors.cryingDetectionSensor.resetTime;
                this.sensorHandler(true, this.sensors.hksvSensor);
                break;
            case 2:
                this.sensorHandler(true, this.sensors.crossingDetectionSensor);
                this.sensors.hksvSensor.resetTime = this.sensors.crossingDetectionSensor.resetTime;
                this.sensorHandler(true, this.sensors.hksvSensor);
                break;
            case 3:
                this.sensorHandler(true, this.sensors.noiseSensor);
                this.sensors.hksvSensor.resetTime = this.sensors.noiseSensor.resetTime;
                this.sensorHandler(true, this.sensors.hksvSensor);
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
