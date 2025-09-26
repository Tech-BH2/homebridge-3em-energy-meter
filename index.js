'use strict';

const util = require('util');
const axios = require('axios');

let Service, Characteristic, UUIDGen;
let FakeGatoHistoryService;

module.exports = (api) => {
  // HAP classes
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Initialize FakeGato
  FakeGatoHistoryService = require('fakegato-history')(api);

  // Register the platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.accessories = new Map();

    if (api) {
      api.on('didFinishLaunching', () => {
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

        // Only JSON-safe fields in context
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

    const { Service, Characteristic } = platform.api.hap;

    // Define Eve custom characteristics
    function EveCurrentConsumption() {
      Characteristic.call(this, 'Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
    util.inherits(EveCurrentConsumption, Characteristic);
    EveCurrentConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    function EveTotalConsumption() {
      Characteristic.call(this, 'Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
    util.inherits(EveTotalConsumption, Characteristic);
    EveTotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

    function EveVoltage() {
      Characteristic.call(this, 'Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
    util.inherits(EveVoltage, Characteristic);
    EveVoltage.UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

    // Set up main service
    this.service = accessory.getService(Service.Outlet) || accessory.addService(Service.Outlet, accessory.context.name);
    this.service.setCharacteristic(Characteristic.On, true);

    // Add Eve characteristics
    this.powerConsumption = this.service.getCharacteristic(EveCurrentConsumption) || this.service.addCharacteristic(EveCurrentConsumption);
    this.totalConsumption = this.service.getCharacteristic(EveTotalConsumption) || this.service.addCharacteristic(EveTotalConsumption);
    this.voltage = this.service.getCharacteristic(EveVoltage) || this.service.addCharacteristic(EveVoltage);

    // FakeGato history
    this.loggingService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });

    // Polling timer
    this.updateTimer = setInterval(() => this.updateData(), 60000);

    platform.log(`${accessory.displayName} initialized`);
  }

  async fetchEmeterData() {
    try {
      const response = await axios.get(`http://${this.config.host}/status`, {
        auth: this.config.auth,
        timeout: 5000,
      });
      return response.data.emeters;
    } catch (error) {
      this.platform.log.error('Error fetching emeter data:', error);
      return null;
    }
  }

  async getCurrentPower() {
    const emeters = await this.fetchEmeterData();
    if (emeters) {
      const totalPower = emeters.reduce((sum, emeter) => sum + emeter.power, 0);
      return totalPower;
    }
    return 0;
  }

  async getTotalConsumption() {
    const emeters = await this.fetchEmeterData();
    if (emeters) {
      const totalConsumption = emeters.reduce((sum, emeter) => sum + emeter.total, 0);
      return totalConsumption;
    }
    return 0;
  }

  async getVoltage() {
    const emeters = await this.fetchEmeterData();
    if (emeters) {
      const totalVoltage = emeters.reduce((sum, emeter) => sum + emeter.voltage, 0);
      return totalVoltage / emeters.length;
    }
    return 0;
  }

  updateData() {
    this.getCurrentPower()
      .then(value => {
        this.powerConsumption.updateValue(value);
        this.loggingService.addEntry({ time: Date.now() / 1000, power: value });
      })
      .catch(err => this.platform.log.error('Error updating power:', err));

    this.getTotalConsumption()
      .then(value => this.totalConsumption.updateValue(value))
      .catch(err => this.platform.log.error('Error updating total consumption:', err));

    this.getVoltage()
      .then(value => this.voltage.updateValue(value))
      .catch(err => this.platform.log.error('Error updating voltage:', err));
  }
}