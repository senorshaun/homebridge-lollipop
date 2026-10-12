'use strict';

const path = require('path');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { AccountController, AccountUiError } = require('./accountController');

class LollipopUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const accounts = new AccountController({
      storagePath: path.join(this.homebridgeStoragePath, 'lollipop'),
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
