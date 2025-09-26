'use strict';

const http = require('http');
const https = require('https');
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
      super('Total Consumption', 'E863F11E-079E-48FF-8F27-9C2605A29F52');
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
      super('Voltage', 'E863F129-079E-48FF-8F27-9C2605A29F52');
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

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config = {}, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.devices = this.config.devices || [];

    if (api) {
      this.api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }
  }

  discoverDevices() {
    this.devices.forEach((device) => {
      if (!device.host) {
        this.log.error(`Device ${device.name || 'Unnamed'} missing host`);
        return;
      }

      const uuid = UUIDGen.generate(device.id || device.name);
      let accessory = this.accessories.find((acc) => acc.UUID === uuid);

      if (!accessory) {
        this.log(`Creating new accessory for ${device.name}`);
        accessory = new this.api.platformAccessory(device.name, uuid);

        new EnergyMeterAccessory(this.log, accessory, device, this.api);

        this.api.registerPlatformAccessories(
          'homebridge-3em-energy-meter',
          '3EMEnergyMeter',
          [accessory]
        );
        this.accessories.push(accessory);
      } else {
        this.log(`Restoring accessory for ${device.name}`);
        new EnergyMeterAccessory(this.log, accessory, device, this.api);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class EnergyMeterAccessory {
  constructor(log, accessory, device, api) {
    this.log = log;
    this.accessory = accessory;
    this.device = device;
    this.api = api;

    this.service = accessory.getService(Service.Outlet) || accessory.addService(Service.Outlet, device.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getCurrentPower.bind(this));

    this.service.addCharacteristic(new EveCurrentConsumption())
      .onGet(this.getCurrentPower.bind(this));

    this.service.addCharacteristic(new EveTotalConsumption())
      .onGet(this.getTotalPower.bind(this));

    this.service.addCharacteristic(new EveVoltage())
      .onGet(this.getVoltage.bind(this));

    this.fakegato = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });
  }

  getShellyJSON(path, callback) {
    const url = `http://${this.device.host}/status${path}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          callback(null, JSON.parse(data));
        } catch (err) {
          callback(err);
        }
      });
    }).on('error', (err) => { callback(err); });
  }

  getCurrentPower() {
    return new Promise((resolve, reject) => {
      this.getShellyJSON('/emeter/0', (err, data) => {
        if (err) return reject(err);
        resolve(data.power || 0);
      });
    });
  }

  getTotalPower() {
    return new Promise((resolve, reject) => {
      this.getShellyJSON('/emeter/0', (err, data) => {
        if (err) return reject(err);
        resolve((data.total || 0) / 1000); // convert Wh -> kWh
      });
    });
  }

  getVoltage() {
    return new Promise((resolve, reject) => {
      this.getShellyJSON('/emeter/0', (err, data) => {
        if (err) return reject(err);
        resolve(data.voltage || 0);
      });
    });
  }
}