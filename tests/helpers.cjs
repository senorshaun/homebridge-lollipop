'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinModules } = require('node:module');
const { EventEmitter } = require('node:events');

// Exercise the repository's JavaScript directly. Only external process, network,
// and HomeKit boundaries are mocked; no dependency installation is necessary.
function createEnvironment() {
  const state = {
    mqtt: [], controllers: [], spawns: [], logs: [], timers: new Map(),
    registered: [], unregistered: [], published: [], soundMachines: [], recordingDelegates: [],
  };
  let timerId = 0;
  const timers = {
    setTimeout(callback, delay, ...args) {
      const handle = { id: ++timerId, unref() { return this; } };
      state.timers.set(handle, { callback: () => callback(...args), delay });
      return handle;
    },
    clearTimeout(handle) { state.timers.delete(handle); },
  };

  class TestService {
    constructor(type, displayName, subtype) {
      this.type = type;
      this.displayName = displayName;
      this.subtype = subtype;
      this.characteristics = new Map();
      this.value = false;
    }
    setCharacteristic(characteristic, value) {
      this.characteristics.set(characteristic, value);
      return this;
    }
    updateCharacteristic(characteristic, value) {
      this.characteristics.set(characteristic, value);
      this.value = value;
      return this;
    }
    getCharacteristic(characteristic) {
      return { value: this.characteristics.get(characteristic) };
    }
  }

  const Service = Object.fromEntries([
    'AccessoryInformation', 'MotionSensor', 'ContactSensor', 'Switch',
  ].map(name => [name, class ServiceType {}]));
  const Characteristic = Object.fromEntries([
    'Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision',
    'MotionDetected', 'ContactSensorState',
  ].map(name => [name, name]));
  const generateUUID = name => 'test-uuid:' + name;

  class TestAccessory extends EventEmitter {
    constructor(displayName, uuid = generateUUID(displayName + ' Camera')) {
      super();
      this.displayName = displayName;
      this.UUID = uuid;
      this.services = [new TestService(Service.AccessoryInformation, 'AccessoryInformation')];
      this.controllers = [];
    }
    getService(typeOrName) {
      return this.services.find(service => service.type === typeOrName || service.displayName === typeOrName);
    }
    addService(type, displayName, subtype) {
      const service = new TestService(type, displayName, subtype);
      this.services.push(service);
      return service;
    }
    removeService(service) {
      this.services = this.services.filter(item => item !== service);
    }
    configureController(controller) {
      this.controllers.push(controller);
      state.controllers.push(controller);
    }
  }

  const api = new EventEmitter();
  api.hap = {
    Service, Characteristic,
    Categories: { IP_CAMERA: 17, SPEAKER: 26 },
    uuid: { generate: generateUUID },
    CameraController: class CameraController {
      constructor(options) { this.options = options; }
    },
  };
  api.platformAccessory = TestAccessory;
  api.registerPlatformAccessories = (...args) => state.registered.push(args);
  api.unregisterPlatformAccessories = (...args) => state.unregistered.push(args);
  api.publishExternalAccessories = (...args) => state.published.push(args);

  const mqtt = {
    connect(url, options) {
      const client = new EventEmitter();
      Object.assign(client, {
        url, options, subscriptions: [], unsubscriptions: [], endCalls: 0,
        subscribe(topics, callback) {
          this.subscriptions.push(topics);
          if (callback) callback(null, []);
          return this;
        },
        unsubscribe(topics) { this.unsubscriptions.push(topics); return this; },
        end() { this.endCalls++; return this; },
      });
      state.mqtt.push(client);
      return client;
    },
  };
  const childProcess = {
    spawn(binary, args) {
      state.spawns.push({ binary, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {}, write() {} };
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('synthetic-snapshot-data'));
        child.emit('close', 0);
      });
      return child;
    },
  };

  const cache = new Map();
  const nativeModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
  function loadModule(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const requireFromModule = name => {
      if (name === 'mqtt') return mqtt;
      if (name === 'child_process' || name === 'node:child_process') return childProcess;
      if (name === 'dgram' || name === 'node:dgram') {
        return { createSocket() { throw new Error('Unexpected real-time UDP request'); } };
      }
      if (name === 'ffmpeg-for-homebridge') return 'mock-ffmpeg';
      if (name === 'pick-port') return async () => { throw new Error('Unexpected port request'); };
      if (name === './soundmachine') {
        return class SoundMachine { constructor(...args) { state.soundMachines.push(args); } };
      }
      if (name === './recordingDelegate') {
        return {
          PREBUFFER_LENGTH: 4000, FRAGMENTS_LENGTH: 4000,
          RecordingDelegate: class RecordingDelegate {
            constructor(...args) { state.recordingDelegates.push(args); }
          },
        };
      }
      if (name === './ffmpeg') {
        return { FfmpegProcess: class FfmpegProcess { constructor() { throw new Error('Unexpected live stream'); } } };
      }
      if (name.startsWith('.')) {
        const candidate = path.resolve(path.dirname(filename), name);
        return loadModule(path.extname(candidate) ? candidate : candidate + '.js');
      }
      if (nativeModules.has(name.replace(/^node:/, ''))) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, require: requireFromModule,
      Buffer, URL, URLSearchParams, process: { env: {}, argv: [] },
      ...timers,
    }, { filename });
    return module.exports;
  }

  const Lollipop = loadModule(path.resolve(__dirname, '../lib/lollipop.js'));
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
    level, (...args) => state.logs.push({ level, args }),
  ]));

  return {
    state, api, Service, Characteristic, TestAccessory, generateUUID,
    createPlatform(config) {
      let Platform;
      loadModule(path.resolve(__dirname, '../index.js'))({
        registerPlatform(pluginName, platformName, constructor) { Platform = constructor; },
      });
      return new Platform(log, config, api);
    },
    createCamera(config, options = {}) {
      config = { name: 'Synthetic camera', hksv: false, ...config };
      const accessory = options.accessory || new TestAccessory(config.name);
      const accessories = options.accessories || {};
      const lollipop = new Lollipop(log, config, accessory, api, accessories);
      return { lollipop, accessory, config: lollipop.config, suppliedConfig: config };
    },
    runTimer(handle) {
      const timer = state.timers.get(handle);
      assert.ok(timer, 'Timer should still be active');
      state.timers.delete(handle);
      timer.callback();
    },
  };
}

module.exports = { createEnvironment };
