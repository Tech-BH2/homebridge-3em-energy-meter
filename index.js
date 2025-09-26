'use strict';

let Service, Characteristic, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  const fakegato = require('fakegato-history')(api);
  FakeGatoHistoryService = fakegato;

  api.registerPlatform('3EMEnergyMeter', EnergyMeterPlatform);
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config;
    this.name = config.name || '3EM Energy Meter';
    this.devices = config.devices || [];

    this.accessories = [];
    if (api) {
      api.on('didFinishLaunching', () => {
        this.log('Finished launching. Setting up devices...');
        this.devices.forEach((dev) => {
          const accessory = new EnergyMeterAccessory(this.log, dev, this.api);
          this.accessories.push(accessory);
        });
      });
    }
  }

  configureAccessory(accessory) {
    this.log('Configuring accessory from cache:', accessory.displayName);
  }
}

class EnergyMeterAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config;

    this.name = config.name || 'Energy Meter';
    this.ip = config.ip;
    this.use_em = config.use_em || false;
    this.use_em_mode = config.use_em_mode || 0;

    this.service = new PowerMeterService(this.name);
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(Characteristic.Model, this.use_em ? 'Shelly EM' : 'Shelly 3EM')
      .setCharacteristic(Characteristic.SerialNumber, this.ip || 'unknown');

    this.loggingService = new FakeGatoHistoryService('energy', this, {
      storage: 'fs',
      path: this.api.user.persistPath(),
      filename: 'energy_' + this.ip + '.json'
    });

    setInterval(() => this.pollDevice(), 10000);
  }

  getServices() {
    return [this.informationService, this.service, this.loggingService];
  }

  async pollDevice() {
    if (!this.ip) return;
    try {
      const http = require('http');
      const url = `http://${this.ip}/status`;
      http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            let meterData;
            if (this.use_em && json.emeters) {
              meterData = json.emeters[this.use_em_mode] || json.emeters[0];
            } else if (json.emeters) {
              meterData = json.emeters[0];
            }
            if (meterData) {
              const power = meterData.power || 0;
              const voltage = meterData.voltage || 0;
              const current = meterData.current || 0;
              const total = meterData.total || 0;

              this.service
                .getCharacteristic(EveCharacteristics.CurrentConsumption)
                .updateValue(power);
              this.service
                .getCharacteristic(EveCharacteristics.Voltage)
                .updateValue(voltage);
              this.service
                .getCharacteristic(EveCharacteristics.ElectricCurrent)
                .updateValue(current);
              this.service
                .getCharacteristic(EveCharacteristics.TotalConsumption)
                .updateValue(total);

              this.loggingService.addEntry({
                time: Math.round(new Date().valueOf() / 1000),
                power: power
              });
            }
          } catch (err) {
            this.log('Error parsing Shelly response:', err.message);
          }
        });
      }).on('error', (err) => {
        this.log('Error polling device:', err.message);
      });
    } catch (e) {
      this.log('Poll failed:', e.message);
    }
  }
}

class PowerMeterService extends Service {
  constructor(displayName, subtype) {
    super(displayName, PowerMeterService.UUID, subtype);
    this.addCharacteristic(EveCharacteristics.CurrentConsumption);
    this.addOptionalCharacteristic(EveCharacteristics.TotalConsumption);
    this.addOptionalCharacteristic(EveCharacteristics.Voltage);
    this.addOptionalCharacteristic(EveCharacteristics.ElectricCurrent);
  }
}
PowerMeterService.UUID = '00000001-0000-1777-8000-775D67EC4377';

// Eve characteristics
const EveCharacteristics = {
  CurrentConsumption: class CurrentConsumption extends Characteristic {
    constructor() {
      super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  },
  TotalConsumption: class TotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  },
  Voltage: class Voltage extends Characteristic {
    constructor() {
      super('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  },
  ElectricCurrent: class ElectricCurrent extends Characteristic {
    constructor() {
      super('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'A',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }
  }
};