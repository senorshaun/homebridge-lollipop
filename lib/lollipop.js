let Characteristic, Service;
const streamingDelegate = require("./streamingDelegate");
let SoundMachine = require("./soundmachine");
const crypto = require('crypto');
const mqtt = require("mqtt");
const { resolveCameraConnection, hasDirectStreamConfig } = require('./cameraConnection');
const { observeMqtt, describeMqttFailure } = require('./mqttDiagnostics');
const { createAuthenticatedMqttOptions } = require('./mqttAuth');

module.exports = class Lollipop {

    constructor(log, config, accessory, api, accessories, accountConnection) {
        Characteristic = api.hap.Characteristic;
        Service = api.hap.Service;
        this.accessory = accessory;
        this.log = log;
        this.config = { ...config };
        this.api = api;
        this.accessories = accessories;
        this.accountMode = !!accountConnection;
        this.mqttCredentials = accountConnection && accountConnection.credentials;
        this.onAuthenticationFailure = accountConnection && accountConnection.onAuthenticationFailure;
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
        if (this.accountMode) {
            try {
                const connection = resolveCameraConnection(this.config);
                this.config.ip = connection.ip;
                this.config.pairingID = this.config.cameraId;
                this.config.source = connection.source;
                // The recovered recording delegate still has unrelated startup defects.
                this.config.hksv = false;
                this.config.prebuffer = false;
            } catch (error) {
                this.log.error('Camera configuration invalid: ' + error.message, this.accessory.displayName);
                return;
            }
            this.setupLollipop();
            return;
        }
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
        let diagnostics;
        this.finishDiscovery = () => {
            if (finished) return false;
            finished = true;
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = undefined;
            this.discoveryClient = undefined;
            if (diagnostics) diagnostics.stop();
            client.end(true);
            return true;
        };
        const fail = (error, stage) => {
            if (this.finishDiscovery()) {
                this.log.error('MQTT discovery failed ' + describeMqttFailure(error, stage) + '. Configure the camera pairing ID as cameraId, or supply its authenticated RTSP URL.', this.accessory.displayName);
            }
        };
        diagnostics = observeMqtt(client, fail);
        this.discoveryTimer = setTimeout(() => {
            fail({ code: 'MQTT_DISCOVERY_TIMEOUT' }, diagnostics.getStage());
        }, 15000);
        this.discoveryTimer.unref?.();
        client.on('close', () => {
            fail({ code: 'MQTT_CONNECTION_CLOSED' }, diagnostics.getStage());
        });
        client.on('connect', () => {
            if (finished) return;
            this.log.debug('MQTT connected initially', this.accessory.displayName);
            diagnostics.setStage('topic subscription');
            client.subscribe('#', (error, granted) => {
                if (finished) return;
                if (error || (granted && granted.some(subscription => subscription.qos === 128))) {
                    fail(error || { code: 'MQTT_SUBSCRIPTION_DENIED' }, diagnostics.getStage());
                    return;
                }
                diagnostics.setStage('waiting for camera ID');
            });
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
        if (this.stopped) return;
        this.stopped = true;
        if (this.finishDiscovery) this.finishDiscovery();
        if (this.stopMqttSubscriptions) this.stopMqttSubscriptions();
        if (this.mqttDiagnostics) this.mqttDiagnostics.stop();
        if (this.soundMachine && this.soundMachine.shutdown) this.soundMachine.shutdown();
        if (this.accessory.client) this.accessory.client.end(true);
        if (this.streamingDelegate) {
            for (const session of this.streamingDelegate.ongoingSessions.keys()) this.streamingDelegate.stopStream(session);
            this.streamingDelegate.pendingSessions.clear();
        }
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
        if (!this.directStream && !this.accountMode) {
            const pairingIDHash = crypto.createHash('md5').update(this.config.pairingID).digest('hex');
            const host = this.config.ip.includes(':') && !this.config.ip.startsWith('[') ? '[' + this.config.ip + ']' : this.config.ip;
            this.config.source = "-rtsp_transport tcp -re -i rtsp://" + host + ":554/live/" + pairingIDHash + "/ch00_0";
        }
        this.config.audio = this.config.audio !== false;
        //this.config.returnAudioTarget = true;
        this.config.prebuffer = this.config.hksv;

        this.log.debug('Creating camera stream', this.accessory.displayName);
        const delegate = new streamingDelegate.StreamingDelegate(this.log, this.config, this.api, this.accessory);
        this.streamingDelegate = delegate;
        this.accessory.configureController(delegate.controller);

        if (this.directStream) {
            for (const sensor of Object.values(this.sensors)) this.initializeSensor(false, sensor);
            this.initializeSoundMachine(false);
            return;
        }
        
        this.startMqttConnection();
        
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

    startMqttConnection() {
        if (this.stopped || (this.accountMode && !this.mqttCredentials)) return;
        let options;
        try {
            options = this.accountMode
                ? createAuthenticatedMqttOptions({ cameraId: this.config.pairingID, ...this.mqttCredentials })
                : { rejectUnauthorized: false };
        } catch (_) {
            this.log.error('MQTT client credentials are invalid. Sign in again in plugin settings.', this.accessory.displayName);
            return;
        }
        this.log.debug('Setting up MQTT connection', this.accessory.displayName);
        const client = mqtt.connect(this.mqttUrl(), {
            ...options, connectTimeout: 15000, reconnectPeriod: 5000,
            clean: true, resubscribe: false, queueQoSZero: false
        });
        this.accessory.client = client;
        if (this.soundMachine && this.soundMachine.setClient) this.soundMachine.setClient(client);
        const current = () => !this.stopped && this.accessory.client === client;
        let subscriptionTimer;
        let generation = 0;
        let ready = false;
        this.stopMqttSubscriptions = () => clearTimeout(subscriptionTimer);
        const unavailable = () => {
            if (!current()) return;
            clearTimeout(subscriptionTimer);
            ready = false;
            generation++;
            if (this.soundMachine && this.soundMachine.setConnected) this.soundMachine.setConnected(false);
        };
        this.mqttDiagnostics = observeMqtt(client, (error, stage) => {
            if (!current()) return;
            unavailable();
            if (!this.mqttErrorReported) {
                this.log.error('MQTT status connection failed ' + describeMqttFailure(error, stage) + '. Camera sensors and sound controls are unavailable.', this.accessory.displayName);
                this.mqttErrorReported = true;
            }
            const code = error && error.code;
            if (this.onAuthenticationFailure && (code === 4 || code === 5 ||
                ['CERT_HAS_EXPIRED', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
                    'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'].includes(code))) this.onAuthenticationFailure();
        });
        client.on('close', unavailable);
        client.on('offline', unavailable);
        client.on('connect', () => {
            if (!current()) return;
            clearTimeout(subscriptionTimer);
            ready = false;
            const connectionGeneration = ++generation;
            this.mqttErrorReported = false;
            this.mqttDiagnostics.setStage('topic subscription');
            const topics = ['liveNote', 'prenotify', 'cameraStatus/return', 'musicStatus/return', 'controlMusic/return']
                .map(topic => this.config.pairingID + '/' + topic);
            const subscribe = () => {
                if (!current() || !client.connected || generation !== connectionGeneration) return;
                client.subscribe(topics, (error, granted) => {
                    if (!current() || !client.connected || generation !== connectionGeneration) return;
                    if (error || !granted || granted.length !== topics.length || granted.some(item => item.qos === 128)) {
                        ready = false;
                        if (this.soundMachine && this.soundMachine.setConnected) this.soundMachine.setConnected(false);
                        if (!this.mqttErrorReported) this.log.error('MQTT topic subscription was rejected. Camera controls are unavailable; retrying.', this.accessory.displayName);
                        this.mqttErrorReported = true;
                        subscriptionTimer = setTimeout(subscribe, 5000);
                        subscriptionTimer.unref?.();
                        if (this.onAuthenticationFailure) this.onAuthenticationFailure();
                        return;
                    }
                    ready = true;
                    this.mqttErrorReported = false;
                    this.mqttDiagnostics.setStage('MQTT session');
                    this.log.debug('MQTT connected and camera topics subscribed.', this.accessory.displayName);
                    if (this.soundMachine && this.soundMachine.setConnected) this.soundMachine.setConnected(true);
                });
            };
            subscribe();
        });
        client.on('message', (topic, message) => {
            if (!current() || !ready || typeof topic !== 'string') return;
            const prefix = this.config.pairingID + '/';
            if (!topic.startsWith(prefix)) return;
            try {
                switch (topic.slice(prefix.length)) {
                    case 'liveNote': this.liveNoteHandler(message); break;
                    case 'prenotify': this.prenotifyHandler(message); break;
                    case 'cameraStatus/return': this.cameraStatusHandler(message); break;
                    case 'musicStatus/return': this.musicStatusHandler(message); break;
                    case 'controlMusic/return':
                        const body = this.decodeMessage(message);
                        if ((body.id === 0 || body.id === undefined) && this.soundMachine && this.soundMachine.controlResult) this.soundMachine.controlResult(body.result);
                        break;
                }
            } catch (_) {
                this.log.debug('Ignored a malformed camera MQTT message.', this.accessory.displayName);
            }
        });
    }

    updateAccountConnection(config, credentials) {
        if (!this.accountMode || this.stopped) return;
        const oldSource = this.config.source;
        const connection = resolveCameraConnection(config);
        const identityChanged = credentials && (!this.mqttCredentials ||
            !Buffer.from(credentials.cert).equals(Buffer.from(this.mqttCredentials.cert)) ||
            !Buffer.from(credentials.key).equals(Buffer.from(this.mqttCredentials.key)));
        const addressChanged = this.config.ip !== connection.ip;
        this.config.ip = connection.ip;
        this.config.source = connection.source;
        if (credentials) this.mqttCredentials = credentials;
        if (oldSource !== connection.source && this.streamingDelegate) this.streamingDelegate.snapshotPromise = undefined;
        if (identityChanged || addressChanged || (!this.accessory.client && this.mqttCredentials)) {
            if (this.stopMqttSubscriptions) this.stopMqttSubscriptions();
            if (this.mqttDiagnostics) this.mqttDiagnostics.stop();
            const previous = this.accessory.client;
            this.accessory.client = undefined;
            if (this.soundMachine && this.soundMachine.setConnected) this.soundMachine.setConnected(false);
            if (previous) previous.end(true);
            this.startMqttConnection();
        }
    }

    decodeMessage(message) {
        const text = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
        if (text.length > 131072) throw new Error('MQTT message too large');
        // Android accepts a JSON object surrounded by a transport/event envelope.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('Missing MQTT object');
        const body = JSON.parse(text.slice(start, end + 1));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid MQTT object');
        return body;
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
        var uuid = this.config.soundMachineUuid || this.api.hap.uuid.generate(this.config.name + ' Sound Machine');
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
            thisSoundMachine.context = thisSoundMachine.context || {};
            if (this.accountMode) {
                thisSoundMachine.context.lollipopCameraId = this.config.pairingID;
                thisSoundMachine.context.lollipopSound = true;
            }
            this.accessories[uuid] = thisSoundMachine;
            this.soundMachine = new SoundMachine(this.log, this.config, thisSoundMachine, this.api, mqttClient);
        } else if (thisSoundMachine) {
            this.log.info('Found sound machine that is not configued. Removing.', this.accessory.displayName);
            this.api.unregisterPlatformAccessories('homebridge-lollipop', 'Lollipop', [thisSoundMachine]);
            delete this.accessories[uuid];
        }
    }

    liveNoteHandler(message) {
        const parsedJSON = this.decodeMessage(message);
        const result = parsedJSON.result || parsedJSON.params;
        if (result && result.motion >= (this.config.movementSensitivity || 100)) {
            this.log.debug('Camera movement detected.', this.accessory.displayName);
            this.sensorHandler(true, this.sensors.movementSensor);
            this.sensors.hksvSensor.resetTime = this.sensors.movementSensor.resetTime;
            this.sensorHandler(true, this.sensors.hksvSensor);
        }
    }

    prenotifyHandler(message) {
        const parsedJSON = this.decodeMessage(message);
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
        const parsedJSON = this.decodeMessage(message);
        if (parsedJSON.result) {
            if (typeof parsedJSON.result.firmwareVersion === 'string' && this.accessory.firmwareNeeded) {
                this.accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, parsedJSON.result.firmwareVersion);
                this.accessory.firmwareNeeded = false;
            }
        }
    }

    musicStatusHandler(message) {
        const parsedJSON = this.decodeMessage(message);
        if (parsedJSON.result) {
            if (this.soundMachine) {
                this.soundMachine.updateOn(parsedJSON.result.playStatus);
                this.soundMachine.getCountdownTimer(parsedJSON.result.countdownTimer);
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
