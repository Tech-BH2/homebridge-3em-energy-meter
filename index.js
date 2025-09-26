'use strict';

const request = require('http'); // native HTTP requests to Shelly EM
const util = require('util');

let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Eve Custom Characteristic for current power consumption
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
  EveCurrentConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

  // Similarly, you can define EveTotalConsumption, EveVoltage if needed

  FakeGatoHistoryService = require('fakegato-history')(api);

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    this.accessories = [];

    if (!this.devices.length) {
      this.log.warn('No devices configured for 3EMEnergyMeter.');
    }

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log('3EMEnergyMeter: didFinishLaunching — creating/restoring devices');
        this.discoverDevices();
      });
    }
  }

  configureAccessory(accessory) {
    this.log(`Configuring cached accessory: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    this.devices.forEach((device) => {
      if (!device.host) {
        this.log.error(`Device ${device.name || device.id || 'Unnamed'} missing host`);
        return;
      }

      const uuid = UUIDGen.generate(device.id || device.host);
      let accessory = this.accessories.find((acc) => acc.UUID === uuid);

      if (!accessory) {
        this.log(`Creating new accessory for ${device.name} (${device.host})`);
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;

        new EnergyMeterAccessory(this.log, accessory, device, this.api);

        this.api.registerPlatformAccessories(
          'homebridge-3em-energy-meter',
          '3EMEnergyMeter',
          [accessory]
        );
        this.accessories.push(accessory);
      } else {
        this.log(`Restoring accessory for ${device.name} (${device.host})`);
        new EnergyMeterAccessory(this.log, accessory, device, this.api);
        this.api.updatePlatformAccessories([accessory]);
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

    this.service = this.accessory.getService(Service.Outlet) || this.accessory.addService(Service.Outlet, device.name);

    // Add Eve Current Consumption characteristic
    this.eveCurrent = this.service.getCharacteristic(EveCurrentConsumption) ||
      this.service.addCharacteristic(EveCurrentConsumption);

    // Add FakeGato history
    this.historyService = new FakeGatoHistoryService('energy', this.accessory, { storage: 'fs', disableTimer: false });

    // Start polling Shelly EM
    this.startPolling();
  }

  startPolling() {
    setInterval(() => this.updateMetrics(), 5000);
  }

  updateMetrics() {
    const host = this.device.host;

    const options = {
      hostname: host,
      port: 80,
      path: '/meter/0',
      method: 'GET',
    };

    const req = request.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          const power = json.power || 0;
          const total = json.total || 0;
          const voltage = json.voltage || 0;

          this.eveCurrent.updateValue(power);

          this.historyService.addEntry({
            time: Math.floor(Date.now() / 1000),
            power: power,
            voltage: voltage,
            current: power / voltage,
            totalEnergy: total / 1000, // Wh → kWh
          });

          this.log.debug(`Updated ${this.device.name}: Power=${power}W, Total=${total}Wh, Voltage=${voltage}V`);
        } catch (err) {
          this.log.error(`Error parsing Shelly EM response for ${this.device.name}: ${err}`);
        }
      });
    });

    req.on('error', (err) => this.log.error(`HTTP request error for ${this.device.name}: ${err}`));
    req.end();
  }
}