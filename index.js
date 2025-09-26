'use strict';

const http = require('http');
const https = require('https');
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

  // FakeGato
  FakeGatoHistoryService = require('fakegato-history')(api);

  class EnergyMeterAccessory {
    constructor(log, accessory, device, api) {
      this.log = log;
      this.accessory = accessory;
      this.device = device;

      this.service = accessory.getService(Service.Outlet) || accessory.addService(Service.Outlet, device.name);

      // Attach Eve characteristics
      this.eveCurrent = this.service.getCharacteristic(EveCurrentConsumption) || this.service.addCharacteristic(EveCurrentConsumption);
      this.eveTotal = this.service.getCharacteristic(EveTotalConsumption) || this.service.addCharacteristic(EveTotalConsumption);
      this.eveVoltage = this.service.getCharacteristic(EveVoltage) || this.service.addCharacteristic(EveVoltage);

      // FakeGato history
      this.historyService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });

      // Start polling
      this.poll();
      setInterval(() => this.poll(), 10000);
    }

    poll() {
      if (!this.device.host) {
        this.log.error(`Device ${this.device.name} missing host`);
        return;
      }

      const options = {
        hostname: this.device.host,
        port: 80,
        path: `/status`,
        method: 'GET'
      };

      http.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // Example mapping for Shelly EM
            const power = parseFloat(json.emeters[0].power) || 0;
            const total = parseFloat(json.emeters[0].total) || 0;
            const voltage = parseFloat(json.emeters[0].voltage) || 0;

            this.eveCurrent.updateValue(power);
            this.eveTotal.updateValue(total / 1000); // convert Wh to kWh
            this.eveVoltage.updateValue(voltage);

            this.historyService.addEntry({
              time: Math.floor(Date.now() / 1000),
              power: power,
              voltage: voltage,
              current: 0
            });
          } catch (err) {
            this.log.error(`Failed to parse Shelly EM response: ${err.message}`);
          }
        });
      }).on('error', (err) => {
        this.log.error(`Error polling device ${this.device.name}: ${err.message}`);
      });
    }
  }

  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;
      this.accessories = [];

      this.devices = config.devices || [];

      api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }

    discoverDevices() {
      this.devices.forEach((device) => {
        if (!device.host) {
          this.log.error(`Device ${device.name || "Unnamed"} missing host`);
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