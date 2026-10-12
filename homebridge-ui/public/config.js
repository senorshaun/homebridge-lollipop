(function (root) {
  'use strict';

  function withLollipopConfig(blocks) {
    const configs = Array.isArray(blocks) ? blocks.map(config => ({ ...config })) : [];
    let index = configs.findIndex(config => config.platform === 'Lollipop');
    if (index < 0) {
      index = configs.length;
      configs.push({ platform: 'Lollipop', name: 'Lollipop' });
    }
    return { configs, config: configs[index] };
  }

  function configureAccount(blocks, email) {
    const { configs, config } = withLollipopConfig(blocks);
    // Successful interactive sign-in replaces any headless credentials. The
    // private session has already been saved by the account service on the host.
    config.account = { email: email.trim().toLowerCase() };
    config.cameraDefaults = {
      audio: true,
      enableSoundMachine: true,
      ...config.cameraDefaults,
    };
    return configs;
  }

  function configureDebug(blocks, enabled) {
    const { configs, config } = withLollipopConfig(blocks);
    // Only this setting changes: manual cameras and headless account settings
    // remain intact when debug logging is enabled before interactive sign-in.
    config.debug = enabled === true;
    return configs;
  }

  const api = { configureAccount, configureDebug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LollipopSetupConfig = api;
})(typeof window === 'undefined' ? globalThis : window);
