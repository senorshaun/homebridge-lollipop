(function (root) {
  'use strict';

  function configureAccount(blocks, email) {
    const configs = Array.isArray(blocks) ? blocks.map(config => ({ ...config })) : [];
    let index = configs.findIndex(config => config.platform === 'Lollipop');
    if (index < 0) {
      index = configs.length;
      configs.push({ platform: 'Lollipop', name: 'Lollipop' });
    }
    const config = configs[index];
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

  const api = { configureAccount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LollipopSetupConfig = api;
})(typeof window === 'undefined' ? globalThis : window);
