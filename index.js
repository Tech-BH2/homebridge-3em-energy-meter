'use strict';

const http = require('http');
const FakeGatoHistoryService = require('fakegato-history');

let Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.api = api;
      this.config = config || {};
      this.devices = this.config.devices || [];
      this.accessories = [];

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

          new EnergyMeterAccessory(this.log, accessory, device);

          this.api.registerPlatformAccessories(
            'homebridge-3em-energy-meter',
            '3EMEnergyMeter',
            [accessory]
          );
          this.accessories.push(accessory);
        } else {
          this.log(`Restoring accessory for ${device.name}`);
          new EnergyMeterAccessory(this.log, accessory, device);
        }
      });
    }
  }

  class EnergyMeterAccessory {
    constructor(log, accessory, device) {
      this.log = log;
      this.accessory = accessory;
      this.device = device;

      // Accessory information
      this.accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
        .setCharacteristic(Characteristic.Model, 'EM')
        .setCharacteristic(Characteristic.SerialNumber, device.id);

      // Outlet service
      this.service = this.accessory.getService(Service.Outlet) || this.accessory.addService(Service.Outlet, device.name);

      // Custom Eve characteristics
      this.currentPower = this.service.addCharacteristic(new Characteristic('Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52'));
      this.currentPower.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });

      this.totalEnergy = this.service.addCharacteristic(new Characteristic('Total Consumption', 'E863F10F-079E-48FF-8F27-9C2605A29F52'));
      this.totalEnergy.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });

      this.voltage = this.service.addCharacteristic(new Characteristic('Voltage', 'E863F110-079E-48FF-8F27-9C2605A29F52'));
      this.voltage.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });

      // FakeGato history
      this.historyService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });

      this.startPolling();
    }

    startPolling() {
      this.update();
      setInterval(() => this.update(), 5000);
    }

    update() {
      const options = {
        host: this.device.host,
        port: 80,
        path: '/status',
        method: 'GET',
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const em = json.emeters[0];
            const power = em.power;
            const total = em.total;
            const voltage = em.voltage;

            this.currentPower.updateValue(power);
            this.totalEnergy.updateValue(total / 1000);
            this.voltage.updateValue(voltage);

            this.historyService.addEntry({
              time: Math.floor(Date.now() / 1000),
              energy: total / 1000,
              power: power,
            });
          } catch (err) {
            this.log.error('Error parsing Shelly EM data:', err.message);
          }
        });
      });

      req.on('error', (err) => {
        this.log.error('HTTP request error:', err.message);
      });

      req.end();
    }
  }

  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};