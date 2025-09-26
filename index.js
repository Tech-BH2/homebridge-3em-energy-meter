'use strict';

const http = require('http');

let Service, Characteristic, UUIDGen;
let FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  FakeGatoHistoryService = require('fakegato-history')(api);

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

        accessory.context = {
          name: deviceConfig.name,
          host: deviceConfig.host,
          auth: deviceConfig.auth,
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

    // ===== Eve custom characteristics (ES6 classes) =====
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
    EveCurrentConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    class EveTotalConsumption extends Characteristic {
      constructor() {
        super('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'kWh',
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    }
    EveTotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

    class EveVoltage extends Characteristic {
      constructor() {
        super('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'V',
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    }
    EveVoltage.UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

    // ===== Main service =====
    this.service = accessory.getService(Service.Outlet) || accessory.addService(Service.Outlet, accessory.context.name);
    this.service.setCharacteristic(Characteristic.On, true);

    this.powerConsumption = this.service.getCharacteristic(EveCurrentConsumption) || this.service.addCharacteristic(EveCurrentConsumption);
    this.totalConsumption = this.service.getCharacteristic(EveTotalConsumption) || this.service.addCharacteristic(EveTotalConsumption);
    this.voltage = this.service.getCharacteristic(EveVoltage) || this.service.addCharacteristic(EveVoltage);

    // ===== FakeGato history =====
    this.loggingService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });

    // ===== Start polling =====
    this.updateTimer = setInterval(() => this.updateData(), 60000);

    platform.log(`${accessory.displayName} initialized`);
  }

  fetchEmeterData() {
    return new Promise((resolve) => {
      const url = `http://${this.config.host}/status`;
      const options = {};

      if (this.config.auth && this.config.auth.user && this.config.auth.pass) {
        const auth = Buffer.from(`${this.config.auth.user}:${this.config.auth.pass}`).toString('base64');
        options.headers = { 'Authorization': `Basic ${auth}` };
      }

      http.get(url, options, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve(parsed.emeters || []);
          } catch (e) {
            this.platform.log.error(`Failed parsing response from ${this.config.host}:`, e.message);
            resolve([]);
          }
        });
      }).on('error', (err) => {
        this.platform.log.error(`HTTP error fetching data from ${this.config.host}:`, err.message);
        resolve([]);
      });
    });
  }

  async getCurrentPower() {
    const emeters = await this.fetchEmeterData();
    return emeters.reduce((sum, em) => sum + (em.power || 0), 0);
  }

  async getTotalConsumption() {
    const emeters = await this.fetchEmeterData();
    return emeters.reduce((sum, em) => sum + (em.total || 0), 0);
  }

  async getVoltage() {
    const emeters = await this.fetchEmeterData();
    if (emeters.length === 0) return 0;
    const totalVoltage = emeters.reduce((sum, em) => sum + (em.voltage || 0), 0);
    return totalVoltage / emeters.length;
  }

  updateData() {
    this.getCurrentPower()
      .then(value => {
        this.powerConsumption.updateValue(value);
        this.loggingService.addEntry({ time: Math.floor(Date.now() / 1000), power: value });
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