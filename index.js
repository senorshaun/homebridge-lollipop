"use strict";
const logger = require("./lib/logger");
let Lollipop = require("./lib/lollipop");
const PLUGIN_NAME = 'homebridge-lollipop';
const PLATFORM_NAME = 'Lollipop';

module.exports = (homebridge) => {
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LollipopPlatform);
};
class LollipopPlatform {
    constructor(log, config, api) {
        this.accessories = [];
        this.api = api;
        this.config = config;
        this.log = new logger.Logger(log, this.config.debug);
        if (!config || !config.lollipops || config.lollipops.length == 0) {
            this.log.warn("Ignoring Lollipop Platform setup because no lollipops are configured");
            this.disabled = true;
            this.log = null;
            return;
        }
        this.api.on("didFinishLaunching", () => setTimeout(() => this.didFinishLaunching(),1000));
    }

    didFinishLaunching() {
        
        //////////////////////////
        // Remove Deleted
        // Iterate over all accessories in the dictionary, and anything without the flag needs to be removed
        Object.keys(this.accessories).forEach(function(accessoryUuid) {
            var thisAccessory = this.accessories[accessoryUuid];
            if (thisAccessory.existsInConfig !== true) {
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [thisAccessory]);
                this.log.info("Deleted removed lollipop or accessory");
            }
        }.bind(this));

        //////////////////////////
        // Set Up lollipops
        let lollipopArray = this.config.lollipops || [];
        lollipopArray.forEach(function (lollipopConfig) {
            // error handle invalid setups
            if (!lollipopConfig.name) {
                this.log.error('One of your lollipops has no name configured. This lollipop will be skipped.');
            } else if (!lollipopConfig.ip) {
                this.log.error('No IP address specified. This lollipop will be skipped.', lollipopConfig.name);
            } else {
                // lollipop setup
                // create identifier
                var uuid = this.api.hap.uuid.generate(lollipopConfig.name + ' Camera');
                // look to see if it is already cached
                let thislollipop = this.accessories[uuid];
                if (!thislollipop) {
                    // create accessory if it isn't
                    thislollipop = new this.api.platformAccessory(lollipopConfig.name, uuid);
                    this.log.info('Configuring lollipop...', thislollipop.displayName);
                    this.accessories[uuid] = new Lollipop(this.log, lollipopConfig, (thislollipop instanceof Lollipop ?  thislollipop.accessory :  thislollipop), this.api, this.accessories);
                    this.accessories[uuid].existsInConfig = true;
                    // add the flagged way
                    if (lollipopConfig.unbridge) {
                        this.log.info('Adding unbridged. You need to pair to Homekit', thislollipop.displayName);
                        this.api.publishExternalAccessories(PLUGIN_NAME, [thislollipop]);
                    } else {
                        this.log.info('Adding.', thislollipop.displayName);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [thislollipop]);
                    }
                } else {
                    this.log.info('Loading cached lollipop.', thislollipop.displayName);
                    this.accessories[uuid] = new Lollipop(this.log, lollipopConfig, (thislollipop instanceof Lollipop ?  thislollipop.accessory :  thislollipop), this.api, this.accessories);
                    this.accessories[uuid].existsInConfig = true;
                }
            }
        }.bind(this));
    }

    configureAccessory(accessory) {
        if (this.config && this.config.lollipops && this.config.lollipops.find(lollipop => 
            accessory.UUID == this.api.hap.uuid.generate(lollipop.name + ' Camera') 
            || (accessory.UUID == this.api.hap.uuid.generate(lollipop.name + ' Sound Machine')
                && lollipop.enableSoundMachine))){
            accessory.existsInConfig = true;
            this.accessories[accessory.UUID] = accessory;
        } else {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                this.log.info("Deleted removed lollipop or accessory");
        }
        
    }
}