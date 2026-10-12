'use strict';

const path = require('path');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { AccountController, AccountUiError } = require('./accountController');
const { Logger } = require('../lib/logger');

class LollipopUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    // Homebridge UI captures this process's console. Only the shared, redacting
    // Logger may write diagnostics here; account requests never print raw data.
    const logger = new Logger({
      info: message => console.info(message),
      warn: message => console.warn(message),
      error: message => console.error(message),
      debug() {},
    });
    const accounts = new AccountController({
      storagePath: path.join(this.homebridgeStoragePath, 'lollipop'),
      logger,
    });

    for (const route of ['/account/login', '/account/otp', '/account/status', '/account/cancel']) {
      this.onRequest(route, async payload => {
        try {
          return await accounts.handle(route, payload);
        } catch (error) {
          // RequestError suppresses Homebridge UI's default raw-error logging.
          const safe = new AccountUiError(error && error.code);
          throw new RequestError(safe.message, { code: safe.code });
        }
      });
    }
    this.ready();
  }
}

new LollipopUiServer();
