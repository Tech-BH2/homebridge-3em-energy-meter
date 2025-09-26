'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Initialize FakeGato
  FakeGatoHistoryService = require('fakegato-history')(api);

  // ------------------------
  // Custom Characteristics
  // ------------------------
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
      super('Total Consumption', 'E863F11D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }
  EveTotalConsumption.UUID = 'E863F11D-079E-48FF-8F27-9C2605A29F52';

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
  EveVoltage.UUID = 'E863F12D-079E-48FF-8F27-9C2605A29F52';

  // ------------------------
  // Helper function to GET JSON from Shelly device
  // ------------------------
  function getJSON(host, path, auth, callback) {
    const isHttps = host.startsWith('https://');
    const parsedUrl = url.parse((isHttps ? 'https://' : 'http://') + host + path);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      method: 'GET',
      auth: auth ? `${auth.user}:${auth.pass}` : undefined,
      timeout: 5000
    };

    const reqModule = isHttps ? https : http;

    const req = reqModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          callback(null, json);
        } catch (err) {
          callback(err);
        }
      });
    });

    req.on('error', (err) => callback(err));
    req.on('timeout', () => {
      req.destroy();
      callback(new Error('Request timed out'));
    });

    req.end();
  }

  // ------------------------
  // EnergyMeter Accessory
  // ------------------------
  class EnergyMeterAccessory {
    constructor(device, log) {
      this.name = device.name;
      this.host = device.host;
      this.use_em = device.use_em;
      this.auth = device.auth;
      this.log = log;

      this.service = new Service.Outlet(this.name);
      this.service.getCharacteristic(Characteristic.On)
        .onGet(() => true); // Always on, for EVE consumption

      // Add custom characteristics
      this.currentConsumption = this.service.addCharacteristic(new EveCurrentConsumption());
      this.totalConsumption = this.service.addCharacteristic(new EveTotalConsumption());
      this.voltage = this.service.addCharacteristic(new EveVoltage());

      // FakeGato for EVE history
      this.historyService = new FakeGatoHistoryService('energy', this, { storage: 'fs', minutes: 1 });

      // Start polling
      this.poll();
      setInterval(() => this.poll(), 10000);
    }

    poll() {
      // Use Shelly EM endpoint
      getJSON(this.host, '/status', this.auth, (err, data) => {
        if (err) {
          this.log('Error fetching data from', this.name, err.message);
          return;
        }

        // Single-phase values
        const emeter = this.use_em && data.emeters ? data.emeters[0] : data.emeter || { power: 0, total: 0, voltage: 0 };

        const power = emeter.power || 0;
        const total = emeter.total || 0;
        const voltage = emeter.voltage || 0;

        this.currentConsumption.updateValue(power);
        this.totalConsumption.updateValue(total);
        this.voltage.updateValue(voltage);

        this.historyService.addEntry({
          time: Math.floor(Date.now() / 1000),
          power: power,
          voltage: voltage,
          temp: 0
        });
      });
    }

    getServices() {
      return [this.service, this.historyService];
    }
  }

  // ------------------------
  // Platform Definition
  // ------------------------
  class EnergyMeterPlatform {
    constructor(log, config) {
      this.log = log;
      this.config = config;
      this.accessories = [];

      if (!config.devices || !Array.isArray(config.devices)) {
        log('No devices configured');
        return;
      }

      this.config.devices.forEach(device => {
        try {
          const accessory = new EnergyMeterAccessory(device, log);
          this.accessories.push(accessory);
        } catch (err) {
          log('Failed to create accessory for', device.name, err.message);
        }
      });
    }

    configureAccessory(accessory) {
      // Called by Homebridge, can be ignored in this simple implementation
    }

    discoverDevices(callback) {
      callback();
    }
  }

  // Register platform
  api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform, true);
};