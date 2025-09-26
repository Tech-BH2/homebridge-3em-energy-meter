'use strict';

const http = require('http');
const util = require('util');
let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Eve custom characteristics
  class EveCurrentConsumption extends Characteristic {
    constructor() {
      super('Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }

  class EveTotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', 'E863F11D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }

  class EveVoltage extends Characteristic {
    constructor() {
      super('Voltage', 'E863F12D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }

  FakeGatoHistoryService = require('fakegato-history')(api);

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (api) {
      api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }
  }

  configureAccessory(accessory) {
    // Called once for each cached accessory restored
    this.accessories.push(accessory);
    this.log(`Restored accessory from cache: ${accessory.displayName}`);
  }

  discoverDevices() {
    const devices = this.config.devices || [];
    devices.forEach(device => {
      let existing = this.accessories.find(acc => acc.context.deviceId === device.id);
      if (!existing) {
        const accessory = new this.api.platformAccessory(device.name, UUIDGen.generate(device.id));
        accessory.context.deviceId = device.id;

        const emAcc = new EnergyMeterAccessory(this.log, device, accessory, this.api);
        accessory.addService(emAcc.service);

        this.accessories.push(accessory);
        this.api.registerPlatformAccessories('homebridge-3em-energy-meter', '3EMEnergyMeter', [accessory]);
        this.log(`Registered new accessory: ${device.name}`);
      }
    });
  }
}

class EnergyMeterAccessory {
  constructor(log, config, accessory, api) {
    this.log = log;
    this.config = config;
    this.accessory = accessory;
    this.api = api;

    // Services
    this.service = new Service.Outlet(this.config.name || 'Energy Meter');

    // Eve characteristics
    this.currentConsumption = new EveCurrentConsumption();
    this.totalConsumption = new EveTotalConsumption();
    this.voltage = new EveVoltage();

    this.service.addCharacteristic(this.currentConsumption);
    this.service.addCharacteristic(this.totalConsumption);
    this.service.addCharacteristic(this.voltage);

    // FakeGato for EVE history
    this.historyService = new FakeGatoHistoryService('energy', this.accessory, { storage: 'fs', log: this.log });

    // Poll device
    this.pollingInterval = setInterval(() => this.updateValues(), 10000);
  }

  updateValues() {
    this.getCurrentPower((err, watts) => {
      if (!err) {
        this.currentConsumption.updateValue(watts);
        this.historyService.addEntry({ watts: watts, kilowatts: watts / 1000 });
      }
    });

    this.getTotalEnergy((err, kWh) => {
      if (!err) this.totalConsumption.updateValue(kWh);
    });

    this.getVoltage((err, volts) => {
      if (!err) this.voltage.updateValue(volts);
    });
  }

  // Shelly EM integration
  getCurrentPower(callback) {
    const options = {
      hostname: this.config.host,
      port: 80,
      path: '/status',
      method: 'GET',
      auth: this.config.auth ? `${this.config.auth.user}:${this.config.auth.pass}` : undefined
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const watts = json.emeters[0].power;
          callback(null, watts);
        } catch (e) { callback(e); }
      });
    });

    req.on('error', e => callback(e));
    req.end();
  }

  getTotalEnergy(callback) {
    const options = {
      hostname: this.config.host,
      port: 80,
      path: '/status',
      method: 'GET',
      auth: this.config.auth ? `${this.config.auth.user}:${this.config.auth.pass}` : undefined
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const kWh = json.emeters[0].total / 1000; // Shelly returns Wh
          callback(null, kWh);
        } catch (e) { callback(e); }
      });
    });

    req.on('error', e => callback(e));
    req.end();
  }

  getVoltage(callback) {
    const options = {
      hostname: this.config.host,
      port: 80,
      path: '/status',
      method: 'GET',
      auth: this.config.auth ? `${this.config.auth.user}:${this.config.auth.pass}` : undefined
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const volts = json.emeters[0].voltage;
          callback(null, volts);
        } catch (e) { callback(e); }
      });
    });

    req.on('error', e => callback(e));
    req.end();
  }
}