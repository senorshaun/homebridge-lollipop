'use strict';

const path = require('path');
const { AccountController, AccountUiError } = require('./accountController');
const { Logger } = require('../lib/logger');

// Homebridge UI captures this process's console. Only the shared, redacting
// Logger may write plugin diagnostics here; account requests never print raw data.
const logger = new Logger({
  info: message => console.info(message),
  warn: message => console.warn(message),
  error: message => console.error(message),
  debug() {},
});

async function startServer() {
  // Version 2 of plugin-ui-utils is an ES module. Dynamic import lets the
  // Homebridge entry point and our shared account code remain CommonJS.
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class LollipopUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
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

  return new LollipopUiServer();
}

startServer().catch(() => {
  // A loader error can include paths or environment details. Keep startup errors
  // fixed, and exit so Homebridge UI detects the failed server instead of waiting.
  logger.error('Unable to start the Lollipop settings server. Check the supported Node.js version and reinstall the plugin dependencies.');
  process.exit(1);
});
