'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual sound runtime; only HAP and the unrelated diagnostic sink
// are substituted. The production module has no new package dependencies.
function fixture({ camera = 'Nursery', displayName, configuredName, serviceName, context = {} } = {}) {
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/soundmachine.js'), 'utf8'), {
    module: exports,
    require(name) {
      assert.equal(name, './diagnostics');
      return { emitDiagnostic() {} };
    },
    setTimeout, clearTimeout,
  });
  const SoundMachine = exports.exports;
  const Characteristic = Object.fromEntries(['On', 'Name', 'ConfiguredName', 'Manufacturer', 'Model', 'SerialNumber']
    .map(name => [name, name]));
  const Service = { AccessoryInformation: 'Information', Switch: 'Switch' };
  class HapService {
    constructor(name) { this.displayName = name; this.characteristics = new Map(); this.subtype = 'stable-subtype'; }
    getCharacteristic(type) {
      if (!this.characteristics.has(type)) {
        const characteristic = new EventEmitter();
        characteristic.value = '';
        characteristic.updateValue = value => { characteristic.value = value; return characteristic; };
        this.characteristics.set(type, characteristic);
      }
      return this.characteristics.get(type);
    }
    setCharacteristic(type, value) { this.getCharacteristic(type).value = value; return this; }
    testCharacteristic(type) { return this.characteristics.has(type); }
    addOptionalCharacteristic(type) { this.getCharacteristic(type); }
  }
  const oldName = camera + ' Sound Machine';
  const information = new HapService('Information');
  const service = new HapService(serviceName || oldName);
  service.setCharacteristic(Characteristic.Name, serviceName || oldName);
  if (configuredName !== undefined) service.setCharacteristic(Characteristic.ConfiguredName, configuredName);
  const accessory = { UUID: 'existing-uuid', displayName: displayName || oldName, context: { lollipopCameraId: 'synthetic-id', ...context },
    getService(type) { return type === Service.Switch ? service : information; } };
  const updates = [];
  const api = { hap: { Characteristic, Service }, updatePlatformAccessories(values) { updates.push(values); } };
  const publications = [];
  const client = { connected: true, publish(topic, payload, options, callback) {
    publications.push({ topic, message: JSON.parse(payload), options });
    if (callback) callback();
  } };
  const machine = new SoundMachine({}, { name: camera, pairingID: 'synthetic-id' }, accessory, api, client);
  return { machine, accessory, service, information, api, updates, publications };
}

test('generated switch names migrate to camera Music without changing UUID, subtype, or association', () => {
  const f = fixture();
  assert.equal(f.accessory.displayName, 'Nursery Music');
  assert.equal(f.service.displayName, 'Nursery Music');
  assert.equal(f.service.getCharacteristic('Name').value, 'Nursery Music');
  assert.equal(f.service.getCharacteristic('ConfiguredName').value, 'Nursery Music');
  assert.equal(f.information.getCharacteristic('Name').value, 'Nursery Music');
  assert.equal(f.information.getCharacteristic('ConfiguredName').value, 'Nursery Music');
  assert.equal(f.accessory.UUID, 'existing-uuid');
  assert.equal(f.service.subtype, 'stable-subtype');
  assert.equal(f.accessory.context.lollipopCameraId, 'synthetic-id');
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0][0], f.accessory);
  assert.equal(f.publications.length, 0, 'Renaming must not send a camera command');
});

test('two cameras get distinct Music labels rather than two indistinguishable switches', () => {
  for (const name of ['Nursery', 'Bedroom']) {
    const f = fixture({ camera: name });
    assert.equal(f.service.getCharacteristic('ConfiguredName').value, name + ' Music');
  }
});

test('an explicit HomeKit switch name survives the default-label migration', () => {
  const f = fixture({ configuredName: 'Bedtime sounds', serviceName: 'My preferred name' });
  assert.equal(f.service.getCharacteristic('ConfiguredName').value, 'Bedtime sounds');
  assert.equal(f.service.getCharacteristic('Name').value, 'My preferred name');
  assert.equal(f.service.displayName, 'My preferred name');
});

test('an explicit cached accessory label is not overwritten', () => {
  const f = fixture({ displayName: 'Custom accessory', configuredName: 'My music' });
  assert.equal(f.accessory.displayName, 'Custom accessory');
  assert.equal(f.service.getCharacteristic('ConfiguredName').value, 'My music');
});

test('reapplying the same generated name does not repeatedly invalidate cached accessories', () => {
  const f = fixture();
  f.machine.configureMusicName(f.api);
  f.machine.configureMusicName(f.api);
  assert.equal(f.updates.length, 1);
});

test('a later camera rename updates only the previously generated music label', () => {
  const f = fixture();
  f.machine.config.name = 'Bedroom';
  f.machine.configureMusicName(f.api);
  assert.equal(f.service.getCharacteristic('ConfiguredName').value, 'Bedroom Music');
  assert.equal(f.accessory.UUID, 'existing-uuid');
});

test('renamed Music switch still requires camera-confirmed play and pause; topics are unchanged', () => {
  const f = fixture();
  f.machine.setConnected(true);
  f.machine.updateOn('pause');
  const responses = [];
  f.machine.setOn(true, error => responses.push(error));
  const command = f.publications.find(item => item.message.method === 'controlMusic');
  assert.equal(command.topic, 'synthetic-id/controlMusic');
  assert.equal(command.message.params.playStatus, 'play');
  assert.equal(command.options.retain, false);
  f.machine.controlResult({ status: 1 });
  assert.equal(responses.length, 0, 'Publishing/acknowledging is not playback confirmation');
  f.machine.updateOn('play');
  assert.deepEqual(responses, [null]);
  f.machine.setOn(false, error => responses.push(error));
  f.machine.updateOn('pause');
  assert.deepEqual(responses, [null, null]);
  assert.equal(f.service.getCharacteristic('On').value, false);
  f.machine.shutdown();
});
