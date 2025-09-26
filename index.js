'use strict';

module.exports = (api) => {
  // Grab HAP objects at runtime (guaranteed to exist when Homebridge calls this)
  const Service = api.hap.Service;
  const Characteristic = api.hap.Characteristic;
  const UUID = api.hap.uuid;
  const pluginIdentifier = 'homebridge-3em-energy-meter'; // must match package.json "name"
  const platformName = '3EMEnergyMeter';

  // Safe FakeGato init (newer/older signatures)
  let FakeGatoHistoryService = null;
  try {
    FakeGatoHistoryService = require('fakegato-history')({
      hap: api.hap,
      Service: Service,
      Characteristic: Characteristic
    });
  } catch (e1) {
    try {
      FakeGatoHistoryService = require('fakegato-history')(api.hap);
    } catch (e2) {
      FakeGatoHistoryService = null;
    }
  }

  // Define Eve custom characteristics now that Characteristic is available
  const EveCharacteristics = {
    CurrentConsumption: class extends Characteristic {
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

    TotalConsumption: class extends Characteristic {
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

    Voltage: class extends Characteristic {
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

    ElectricCurrent: class extends Characteristic {
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

  // Factory for custom power meter service
  const PowerMeterServiceUUID = '00000001-0000-1777-8000-775D67EC4377';
  function createPowerMeterService(displayName, subtype) {
    const svc = new Service(displayName, PowerMeterServiceUUID, subtype);
    try {
      svc.addCharacteristic(EveCharacteristics.CurrentConsumption);
      svc.addOptionalCharacteristic(EveCharacteristics.TotalConsumption);
      svc.addOptionalCharacteristic(EveCharacteristics.Voltage);
      svc.addOptionalCharacteristic(EveCharacteristics.ElectricCurrent);
    } catch (e) {
      // some HAP variants might already have characteristics; be defensive
    }
    return svc;
  }

  // Platform implementation
  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.api = api || api;
      this.config = config || {};
      this.devices = Array.isArray(this.config.devices) ? this.config.devices : [];
      this.cachedAccessories = [];

      // configureAccessory will be called by Homebridge to restore cached accessories
      // When launching finishes, create or restore accessories for configured devices
      this.api.on('didFinishLaunching', () => {
        this.log(`${platformName}: didFinishLaunching — creating/restoring ${this.devices.length} devices`);
        this.devices.forEach((device) => this._createOrRestore(device));
      });
    }

    configureAccessory(accessory) {
      // Homebridge gives cached accessories here
      this.log(`${platformName}: configureAccessory (cached): ${accessory.displayName}`);
      this.cachedAccessories.push(accessory);
    }

    _createOrRestore(device) {
      // deterministic uuid per device (use ip or name)
      const identity = `${device.ip || device.name || Math.random().toString(36).slice(2)}`;
      const uuid = UUID.generate(pluginIdentifier + ':' + identity);

      // find cached
      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);

      if (accessory) {
        this.log(`${platformName}: Restoring accessory from cache: ${accessory.displayName}`);
        accessory.context.device = device;
        this._setupAccessory(accessory, device);
      } else {
        this.log(`${platformName}: Creating new accessory for ${device.name || device.ip}`);
        accessory = new this.api.platformAccessory(device.name || device.ip || 'Shelly Power Meter', uuid);
        accessory.context.device = device;
        this._setupAccessory(accessory, device);

        // register with Homebridge so it shows up and is cached
        try {
          this.api.registerPlatformAccessories(pluginIdentifier, platformName, [accessory]);
          this.cachedAccessories.push(accessory);
          this.log(`${platformName}: Registered accessory: ${device.name || device.ip}`);
        } catch (err) {
          this.log(`${platformName}: registerPlatformAccessories error: ${err.message}`);
        }
      }
    }

    _setupAccessory(accessory, device) {
      // Ensure AccessoryInformation exists & update
      try {
        accessory.getService(Service.AccessoryInformation)
          .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
          .setCharacteristic(Characteristic.Model, device.use_em ? 'Shelly EM' : 'Shelly 3EM')
          .setCharacteristic(Characteristic.SerialNumber, device.ip || 'unknown');
      } catch (e) {
        // add if missing
        accessory.addService(Service.AccessoryInformation)
          .setCharacteristic(Characteristic.Manufacturer, 'Shelly');
      }

      // Ensure our custom service exists
      let svc = (accessory.services || []).find((s) => s.UUID === PowerMeterServiceUUID);
      if (!svc) {
        svc = accessory.addService(new Service(device.name || 'Power Meter', PowerMeterServiceUUID, device.ip));
        try { svc.addCharacteristic(EveCharacteristics.CurrentConsumption); } catch (e) {}
        try { svc.addOptionalCharacteristic(EveCharacteristics.TotalConsumption); } catch (e) {}
        try { svc.addOptionalCharacteristic(EveCharacteristics.Voltage); } catch (e) {}
        try { svc.addOptionalCharacteristic(EveCharacteristics.ElectricCurrent); } catch (e) {}
      }

      // Clear old timer if present
      if (accessory.context._pollTimer) {
        clearInterval(accessory.context._pollTimer);
      }

      // create loggingService if not created yet (we keep in accessory.context.loggingService)
      if (!accessory.context.loggingService && FakeGatoHistoryService) {
        try {
          accessory.context.loggingService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });
        } catch (e) {
          accessory.context.loggingService = null;
        }
      }

      // Start polling device
      const interval = Number(device.update_interval) >= 2000 ? Number(device.update_interval) : 10000;
      accessory.context._pollTimer = setInterval(() => this._pollAndUpdate(accessory), interval);

      // immediate first poll
      this._pollAndUpdate(accessory);
    }

    _safeFloat(x) {
      const v = parseFloat(x);
      return isNaN(v) ? 0 : v;
    }

    _pollAndUpdate(accessory) {
      const device = accessory.context.device || {};
      if (!device || !device.ip) {
        this.log(`${platformName}: skipping poll — no IP configured for ${device.name || 'unknown'}`);
        return;
      }

      const http = require('http');
      const url = `http://${device.ip}/status`;
      const req = http.get(url, { timeout: device.timeout || 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            let meterData = null;

            if (json && Array.isArray(json.emeters) && json.emeters.length > 0) {
              if (device.use_em) {
                if (Number(device.use_em_mode) === 0 && json.emeters.length >= 2) {
                  const a = json.emeters[0] || {};
                  const b = json.emeters[1] || {};
                  meterData = {
                    power: this._safeFloat(a.power) + this._safeFloat(b.power),
                    voltage: ((a.voltage ? this._safeFloat(a.voltage) : 0) + (b.voltage ? this._safeFloat(b.voltage) : 0)) /
                             (((a.voltage ? 1 : 0) + (b.voltage ? 1 : 0)) || 1),
                    current: this._safeFloat(a.current) + this._safeFloat(b.current),
                    total: this._safeFloat(a.total) + this._safeFloat(b.total)
                  };
                } else {
                  meterData = json.emeters[Number(device.use_em_mode)] || json.emeters[0];
                }
              } else {
                const a = json.emeters[0] || {};
                const b = json.emeters[1] || {};
                const c = json.emeters[2] || {};
                meterData = {
                  power: this._safeFloat(a.power) + this._safeFloat(b.power) + this._safeFloat(c.power),
                  voltage: (this._safeFloat(a.voltage) + this._safeFloat(b.voltage) + this._safeFloat(c.voltage)) /
                           (((a.voltage ? 1 : 0) + (b.voltage ? 1 : 0) + (c.voltage ? 1 : 0)) || 1),
                  current: this._safeFloat(a.current) + this._safeFloat(b.current) + this._safeFloat(c.current),
                  total: this._safeFloat(a.total) + this._safeFloat(b.total) + this._safeFloat(c.total)
                };
              }
            } else {
              // fallback older firmware keys
              meterData = {
                power: this._safeFloat(json.power),
                voltage: this._safeFloat(json.voltage),
                current: this._safeFloat(json.current),
                total: this._safeFloat(json.total)
              };
            }

            if (!meterData) return;

            const power = this._safeFloat(meterData.power);
            const voltage = this._safeFloat(meterData.voltage);
            const current = this._safeFloat(meterData.current);
            const totalKwh = this._safeFloat(meterData.total) / 1000.0;

            // update characteristics
            const svc = accessory.services && accessory.services.find((s) => s.UUID === PowerMeterServiceUUID);
            if (svc) {
              try { svc.getCharacteristic(EveCharacteristics.CurrentConsumption).updateValue(power); } catch (e) {}
              try { svc.getCharacteristic(EveCharacteristics.Voltage).updateValue(voltage); } catch (e) {}
              try { svc.getCharacteristic(EveCharacteristics.ElectricCurrent).updateValue(current); } catch (e) {}
              try { svc.getCharacteristic(EveCharacteristics.TotalConsumption).updateValue(totalKwh); } catch (e) {}
            }

            // fakegato history
            const hist = accessory.context.loggingService;
            if (hist && typeof hist.addEntry === 'function') {
              try { hist.addEntry({ time: Math.round(Date.now() / 1000), power: Math.round(power) }); } catch (e) {}
            }
          } catch (errJSON) {
            this.log(`${platformName}: JSON parse error from ${device.ip}: ${errJSON.message}`);
          }
        });
      });

      req.on('error', (err) => {
        this.log(`${platformName}: HTTP error polling ${device.ip}: ${err.message}`);
      });
      req.on('timeout', () => {
        req.destroy();
        this.log(`${platformName}: HTTP timeout polling ${device.ip}`);
      });
    }
  }

  // Register platform — first try 3-arg signature, fallback to 2-arg
  try {
    api.registerPlatform(pluginIdentifier, platformName, EnergyMeterPlatform);
  } catch (e) {
    api.registerPlatform(platformName, EnergyMeterPlatform);
  }
};