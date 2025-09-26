'use strict';

const util = require('util');

let Service, Characteristic, UUIDGen;
let FakeGatoHistoryService;

// Eve custom characteristics (UUIDs documented by Elgato Eve reverse-engineering)
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

module.exports = (api) => {
  // initialize fakegato with Homebridge 2.0 API
  FakeGatoHistoryService = require('fakegato-history')(api);

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

        // ✅ Only JSON-safe fields in context
        accessory.context = {
          name: deviceConfig.name,
          host: deviceConfig.host,
          use_em: !!deviceConfig.use_em,
        };

        new EnergyMeterAccessory(this, accessory, deviceConfig);

        this.api.registerPlatformAccessories(
          'homebridge-3em-energy-meter',
          '3EMEnergyMeter',
          [accessory],
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

    const { Service } = this.platform.api.hap;

    this.service = this.accessory.getService(Service.Outlet) ||
                   this.accessory.addService(Service.Outlet, accessory.context.name);

    this.service.setCharacteristic(Characteristic.On, true);

    // Fakegato history service (used by Eve app)
    this.loggingService = new FakeGatoHistoryService('energy', this.accessory, {
      storage: 'fs',
    });

    // Eve characteristics
    this.powerConsumption = this.service.getCharacteristic(EveCurrentConsumption) ||
                            this.service.addCharacteristic(EveCurrentConsumption);

    this.totalConsumption = this.service.getCharacteristic(EveTotalConsumption) ||
                            this.service.addCharacteristic(EveTotalConsumption);

    this.voltage = this.service.getCharacteristic(EveVoltage) ||
                   this.service.addCharacteristic(EveVoltage);

    // Timer for polling device
    this.updateTimer = setInterval(() => this.updateData(), 60000);

    this.platform.log(`${accessory.displayName} initialized`);
  }

  async getCurrentPower() {
    // TODO: Replace with actual Shelly EM HTTP call
    return 42; // watts (test value)
  }

  async getTotalConsumption() {
    // TODO: Replace with Shelly EM total kWh
    return 1.23; // kWh (test value)
  }

  async getVoltage() {
    // TODO: Replace with Shelly EM voltage reading
    return 230.0; // volts (test value)
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