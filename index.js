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
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
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
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
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
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  // Initialize FakeGato
  FakeGatoHistoryService = require('fakegato-history')(api);

  // EnergyMeterAccessory
  class EnergyMeterAccessory {
    constructor(log, device) {
      this.log = log;
      this.name = device.name;
      this.host = device.host;
      this.use_em = device.use_em || false;
      this.auth = device.auth || {};
      this.services = [];

      // Main Outlet service for HomeKit
      this.service = new Service.Outlet(this.name);

      // Add custom Eve characteristics
      this.currentConsumption = this.service.addCharacteristic(new EveCurrentConsumption());
      this.totalConsumption = this.service.addCharacteristic(new EveTotalConsumption());
      this.voltage = this.service.addCharacteristic(new EveVoltage());

      // FakeGato history
      this.fakeGatoService = new FakeGatoHistoryService('energy', this.service, { storage: 'fs' });

      // Start polling
      this.poll();
    }

    poll() {
      this.updateValues();
      setInterval(() => this.updateValues(), 10000); // every 10s
    }

    updateValues() {
      this.getCurrentPower((err, currentPower) => {
        if (!err) this.currentConsumption.updateValue(currentPower);
      });

      this.getTotalEnergy((err, totalEnergy) => {
        if (!err) this.totalConsumption.updateValue(totalEnergy);
      });

      this.getVoltage((err, voltage) => {
        if (!err) this.voltage.updateValue(voltage);
      });

      // Log to FakeGato
      if (this.fakeGatoService && typeof this.fakeGatoService.addEntry === 'function') {
        this.fakeGatoService.addEntry({
          time: Math.floor(new Date().getTime() / 1000),
          watts: this.currentConsumption.value,
          kilowatts: this.totalConsumption.value,
        });
      }
    }

    // Shelly EM HTTP Polling Methods
    getCurrentPower(callback) {
      const path = this.use_em ? '/status/emeters/0' : '/status';
      this.httpGet(path, (err, data) => {
        if (err) return callback(err);
        const power = data.power || (data.emeters && data.emeters[0] && data.emeters[0].power) || 0;
        callback(null, power);
      });
    }

    getTotalEnergy(callback) {
      const path = this.use_em ? '/status/emeters/0' : '/status';
      this.httpGet(path, (err, data) => {
        if (err) return callback(err);
        const total = data.total || (data.emeters && data.emeters[0] && data.emeters[0].total) || 0;
        callback(null, total);
      });
    }

    getVoltage(callback) {
      const path = '/status';
      this.httpGet(path, (err, data) => {
        if (err) return callback(err);
        const voltage = data.voltage || 0;
        callback(null, voltage);
      });
    }

    httpGet(path, callback) {
      const options = {
        host: this.host,
        port: 80,
        path,
        auth: this.auth.user && this.auth.pass ? `${this.auth.user}:${this.auth.pass}` : undefined,
        method: 'GET',
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            callback(null, data);
          } catch (e) {
            callback(e);
          }
        });
      });

      req.on('error', (err) => callback(err));
      req.end();
    }

    getServices() {
      return [this.service, this.fakeGatoService];
    }
  }

  // EnergyMeterPlatform
  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;
      this.accessories = [];

      if (!this.config || !this.config.devices) {
        log.error('No devices configured for 3EMEnergyMeter platform');
        return;
      }

      this.api.on('didFinishLaunching', () => this.discoverDevices());
    }

    discoverDevices() {
      this.config.devices.forEach((deviceConfig) => {
        try {
          const accessory = new EnergyMeterAccessory(this.log, deviceConfig);
          this.accessories.push(accessory);
          this.log.info(`3EMEnergyMeter: Registered accessory: ${accessory.name}`);
        } catch (e) {
          this.log.error(`Failed to create accessory for ${deviceConfig.name}: ${e.message}`);
        }
      });
    }

    accessories() {
      return this.accessories;
    }
  }

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};