'use strict';

const { request } = require('http'); // or use fetch if Node >=18
const path = require('path');
let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Custom Eve Current Consumption characteristic
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

  // Custom Eve Total Consumption characteristic
  class EveTotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', 'E863F126-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  // Custom Eve Voltage characteristic
  class EveVoltage extends Characteristic {
    constructor() {
      super('Voltage', 'E863F10F-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  FakeGatoHistoryService = require('fakegato-history')(api);

  // Energy Meter Accessory
  class EnergyMeterAccessory {
    constructor(log, accessory, device, api) {
      this.log = log;
      this.accessory = accessory;
      this.device = device;
      this.api = api;

      // Initialize FakeGato
      this.historyService = new FakeGatoHistoryService('energy', accessory, {
        storage: 'fs',
        path: path.join(api.user.storagePath(), 'fakegato-history'),
        disableTimer: false,
      });

      this.setupServices();
      this.updateValues();
    }

    setupServices() {
      const acc = this.accessory;

      // Main Outlet service
      acc.getService(Service.Outlet) || acc.addService(Service.Outlet, this.device.name);

      const service = acc.getService(Service.Outlet);

      // Add custom characteristics
      service.getCharacteristic(EveCurrentConsumption) || service.addCharacteristic(EveCurrentConsumption);
      service.getCharacteristic(EveTotalConsumption) || service.addCharacteristic(EveTotalConsumption);
      service.getCharacteristic(EveVoltage) || service.addCharacteristic(EveVoltage);

      // Set basic Outlet props
      service.getCharacteristic(Characteristic.On).on('get', async (callback) => {
        callback(null, true); // always "on"
      });
    }

    async updateValues() {
      if (!this.device.host) return;

      try {
        const res = await fetch(`http://${this.device.host}/status`);
        const data = await res.json();

        const service = this.accessory.getService(Service.Outlet);
        service.updateCharacteristic(EveCurrentConsumption, data.emeters[0].power);
        service.updateCharacteristic(EveTotalConsumption, data.emeters[0].total / 1000); // Wh -> kWh
        service.updateCharacteristic(EveVoltage, data.emeters[0].voltage);

        // Add FakeGato history entry
        this.historyService.addEntry({
          time: Math.floor(Date.now() / 1000),
          power: data.emeters[0].power,
          voltage: data.emeters[0].voltage,
          current: data.emeters[0].current,
        });

        // Repeat updates every 10s
        setTimeout(() => this.updateValues(), 10000);
      } catch (err) {
        this.log.error('Error updating device values:', err.message);
        setTimeout(() => this.updateValues(), 10000);
      }
    }
  }

  // Energy Meter Platform
  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;
      this.accessories = [];

      if (!this.config.devices || !Array.isArray(this.config.devices)) {
        this.log.error('No devices configured for 3EMEnergyMeter platform');
        return;
      }

      this.devices = this.config.devices;

      api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
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

  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};