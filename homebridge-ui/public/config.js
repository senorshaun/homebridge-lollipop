(function (root) {
  'use strict';

  const ALIAS = 'Lollipop';
  const QUALIFIED_ALIAS = 'homebridge-lollipop.Lollipop';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const empty = value => value === undefined || value === null || value === '';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const emailKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

  function conflict() {
    // Do not include account addresses, bridge identities, or credentials here.
    return Object.assign(new Error('Lollipop configuration entries conflict.'), { code: 'CONFIG_CONFLICT' });
  }

  function isLollipop(config) {
    // getPluginConfig() is already scoped to this plugin. A schema-created draft
    // may not yet have its platform discriminator. Reuse it instead of appending
    // a second platform and leaving _bridge/settings in the first one.
    return object(config) && !config.accessory &&
      (empty(config.platform) || config.platform === ALIAS || config.platform === QUALIFIED_ALIAS);
  }

  function fillMissing(target, source, strict = false) {
    for (const [key, value] of Object.entries(source)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      if (empty(target[key])) target[key] = clone(value);
      else if (object(target[key]) && object(value)) fillMissing(target[key], value, strict);
      else if (strict && !empty(value) && JSON.stringify(target[key]) !== JSON.stringify(value)) throw conflict();
    }
    return target;
  }

  function blankCamera(camera) {
    if (!object(camera)) return false; // Leave malformed input for schema validation.
    // Remove only empty, schema-default rows. A partial manual connection or a
    // deliberately edited preference is not safe to discard automatically.
    const defaults = {
      rtspUsername: 'homebridge', enabled: true, audio: true, hksv: false,
      enableSoundMachine: true, movementSensitivity: 10, unbridge: false,
      contactSensors: false, enableCryingDetectionSensor: false,
      enableCrossingDetectionSensor: false, enableNoiseSensor: false,
    };
    return Object.entries(camera).every(([key, value]) =>
      empty(value) || (own(defaults, key) && value === defaults[key]));
  }

  function mergeCameras(left, right) {
    if (left !== undefined && !Array.isArray(left)) throw conflict();
    if (right !== undefined && !Array.isArray(right)) throw conflict();
    const cameras = [];
    const seen = new Set();
    for (const camera of [...(left || []), ...(right || [])]) {
      if (blankCamera(camera)) continue;
      const key = JSON.stringify(camera);
      if (seen.has(key)) continue;
      seen.add(key);
      cameras.push(clone(camera));
    }
    return cameras;
  }

  function withLollipopConfig(blocks, accountOverride) {
    if (blocks !== undefined && blocks !== null && !Array.isArray(blocks)) throw conflict();
    const configs = [];
    let config;
    let cameras;
    for (const source of blocks || []) {
      if (!object(source)) throw conflict();
      if (!isLollipop(source)) {
        configs.push(clone(source));
        continue;
      }
      if (!config) {
        config = {};
        configs.push(config);
      }
      if (source._bridge !== undefined) {
        if (!object(source._bridge)) throw conflict();
        if (!config._bridge) config._bridge = {};
        // Never silently choose between two different child bridges, ports, or
        // pairing identities. Only complementary/matching settings are merged.
        fillMissing(config._bridge, source._bridge, true);
      }
      if (source.account !== undefined && accountOverride === undefined) {
        if (!object(source.account)) throw conflict();
        const previousEmail = emailKey(config.account && config.account.email);
        const nextEmail = emailKey(source.account.email);
        if (previousEmail && nextEmail && previousEmail !== nextEmail) throw conflict();
        if (!config.account) config.account = {};
        const incoming = clone(source.account);
        if (nextEmail) incoming.email = nextEmail;
        fillMissing(config.account, incoming, true);
      }
      if (source.lollipops !== undefined) cameras = mergeCameras(cameras, source.lollipops);
      const settings = { ...source };
      delete settings.platform;
      delete settings._bridge;
      delete settings.account;
      delete settings.lollipops;
      // The first existing block owns explicitly chosen scalar preferences.
      // Later blocks only supply missing settings; false and 0 are not missing.
      fillMissing(config, settings);
    }
    if (!config) {
      config = { platform: ALIAS, name: ALIAS };
      configs.push(config);
    }
    config.platform = ALIAS;
    if (cameras && cameras.length) config.lollipops = cameras;
    if (accountOverride !== undefined) config.account = { email: accountOverride };
    return { configs, config };
  }

  function configureAccount(blocks, email) {
    if (typeof email !== 'string' || !email.trim()) throw conflict();
    const { configs, config } = withLollipopConfig(blocks, emailKey(email));
    // Successful interactive sign-in replaces headless credentials in ALL split
    // Lollipop blocks. The private session is already stored on the host.
    config.cameraDefaults = {
      audio: true,
      enableSoundMachine: true,
      ...config.cameraDefaults,
    };
    return configs;
  }

  function configureDebug(blocks, enabled) {
    const { configs, config } = withLollipopConfig(blocks);
    config.debug = enabled === true;
    return configs;
  }

  const api = { configureAccount, configureDebug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LollipopSetupConfig = api;
})(typeof window === 'undefined' ? globalThis : window);
