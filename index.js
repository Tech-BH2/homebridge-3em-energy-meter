'use strict';

const http = require('http');
let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Load FakeGato
  FakeGatoHistoryService = require('fakegato-history')(api);

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.accessories = [];
    this.devices = this.config.devices || [];

    if (api) {
      api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
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
}

class EnergyMeterAccessory {
  constructor(log, accessory, device, api) {
    this.log = log;
    this.accessory = accessory;
    this.device = device;
    this.api = api;

    // Set up Outlet service
    const service = accessory.getService(Service.Outlet) || accessory.addService(Service.Outlet);
    service.setCharacteristic(Characteristic.Name, device.name);

    // Eve custom characteristic
    const EveCurrentConsumption = new Characteristic({
      name: 'Current Consumption',
      UUID: 'E863F10D-079E-48FF-8F27-9C2605A29F52'
    });
    EveCurrentConsumption.setProps({
      format: Characteristic.Formats.FLOAT,
      unit: 'W',
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    service.addCharacteristic(EveCurrentConsumption);

    // FakeGato history
    this.historyService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs', disableTimer: false });

    // Poll Shelly EM every 5 seconds
    this.updatePower();
    setInterval(() => {
      this.updatePower();
    }, 5000);
  }

  updatePower() {
    this.getCurrentPower((power) => {
      const service = this.accessory.getService(Service.Outlet);
      if (service) {
        service.updateCharacteristic(Characteristic.On, power > 0);
        const eveChar = service.getCharacteristic('EveCurrentConsumption');
        if (eveChar) eveChar.updateValue(power);
        this.historyService.addEntry({ time: Math.floor(Date.now() / 1000), watts: power });
      }
    });
  }

  getCurrentPower(callback) {
    if (!this.device.host) {
      this.log.error(`Device ${this.device.name} missing host`);
      return callback(0);
    }

    const options = {
      hostname: this.device.host,
      port: 80,
      path: '/status',
      method: 'GET',
      timeout: 2000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const power = json.emeters && json.emeters[0] ? json.emeters[0].power : 0;
          callback(power);
        } catch (err) {
          this.log.error(`Error parsing Shelly EM response: ${err}`);
          callback(0);
        }
      });
    });

    req.on('error', (err) => {
      this.log.error(`Error connecting to Shelly EM ${this.device.host}: ${err}`);
      callback(0);
    });

    req.end();
  }
}