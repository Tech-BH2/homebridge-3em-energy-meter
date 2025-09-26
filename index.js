'use strict';

let Service, Characteristic, UUIDGen;

const FakeGatoHistoryService = require('fakegato-history');

module.exports = (api) => {
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    Service = this.api.hap.Service;
    Characteristic = this.api.hap.Characteristic;
    UUIDGen = this.api.hap.uuid;

    this.accessories = new Map();

    if (api) {
      this.api.on('didFinishLaunching', () => {
        this.log('3EMEnergyMeter: didFinishLaunching — creating/restoring devices');
        this.discoverDevices();
      });
    }
  }

  configureAccessory(accessory) {
    this.log(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    if (!this.config.devices || !Array.isArray(this.config.devices)) {
      this.log.warn('No devices configured for 3EMEnergyMeter');
      return;
    }

    for (const deviceConfig of this.config.devices) {
      const uuid = UUIDGen.generate(deviceConfig.host || deviceConfig.name);
      let accessory = this.accessories.get(uuid);

      if (!accessory) {
        this.log(`Creating new accessory for ${deviceConfig.name}`);

        accessory = new this.api.platformAccessory(deviceConfig.name, uuid);

        // ✅ context contains only plain serializable fields
        accessory.context = {
          name: deviceConfig.name,
          host: deviceConfig.host,
          use_em: !!deviceConfig.use_em
        };

        new EnergyMeterAccessory(this, accessory, deviceConfig);

        this.api.registerPlatformAccessories(
          'homebridge-3em-energy-meter',
          '3EMEnergyMeter',
          [accessory]
        );

        this.accessories.set(uuid, accessory);
      } else {
        this.log(`Configuring existing accessory: ${deviceConfig.name}`);
        new EnergyMeterAccessory(this, accessory, deviceConfig);
      }
    }
  }
}

class EnergyMeterAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;

    const { Service, Characteristic } = this.platform.api.hap;

    this.service = this.accessory.getService(Service.Outlet) ||
                   this.accessory.addService(Service.Outlet, accessory.context.name);

    this.service.setCharacteristic(Characteristic.On, true);

    // Fakegato history service (used by Eve app)
    this.loggingService = new FakeGatoHistoryService('energy', this.accessory, {
      storage: 'fs'
    });

    // Example meter characteristic: Current Consumption
    this.powerConsumption = this.service.getCharacteristic(Characteristic.CurrentConsumption) ||
                            this.service.addCharacteristic(Characteristic.CurrentConsumption);

    this.powerConsumption.on('get', this.handlePowerGet.bind(this));

    // ✅ Timer stored in memory only, not context
    this.updateTimer = setInterval(() => this.updateData(), 60000);

    this.platform.log(`${accessory.displayName} initialized`);
  }

  async handlePowerGet(callback) {
    try {
      const value = await this.getCurrentPower();
      callback(null, value);
    } catch (err) {
      this.platform.log.error('Error fetching power:', err);
      callback(err);
    }
  }

  async getCurrentPower() {
    // TODO: replace with actual Shelly EM request
    return 42; // watts, test value
  }

  updateData() {
    this.getCurrentPower()
      .then(value => {
        this.powerConsumption.updateValue(value);
        this.loggingService.addEntry({ time: Date.now() / 1000, power: value });
      })
      .catch(err => this.platform.log.error('Error updating power:', err));
  }
}