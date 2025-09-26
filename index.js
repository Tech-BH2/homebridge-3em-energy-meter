'use strict';

/**
 * Platform plugin for Shelly 3EM / EM (Homebridge 2.0)
 * - All Homebridge-dependent classes are defined inside module.exports so api.hap is available
 * - Fakegato initialization is defensive
 * - Uses a factory function for the custom "PowerMeter" service (compatible with Homebridge child bridges)
 */

module.exports = (api) => {
  // grab HAP objects now (guaranteed to be provided by Homebridge during init)
  const Service = api.hap.Service;
  const Characteristic = api.hap.Characteristic;

  // Initialize Fakegato safely (different versions expect different shapes)
  let FakeGatoHistoryService = null;
  try {
    // Preferred: provide hap + Service + Characteristic
    FakeGatoHistoryService = require('fakegato-history')({
      hap: api.hap,
      Service: Service,
      Characteristic: Characteristic
    });
  } catch (e1) {
    try {
      // Fallback older signature
      FakeGatoHistoryService = require('fakegato-history')(api.hap);
    } catch (e2) {
      // If fakegato is not present or incompatible, keep null and continue
      FakeGatoHistoryService = null;
      // console.error optional: we avoid spamming logs here
    }
  }

  // Define Eve characteristics now that Characteristic is available
  const EveCharacteristics = {
    CurrentConsumption: class CurrentConsumption extends Characteristic {
      constructor() {
        super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'W',
          minValue: 0,
          maxValue: 1e9,
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
          minValue: 0,
          maxValue: 1e12,
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
          minValue: 0,
          maxValue: 1e6,
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
          minValue: 0,
          maxValue: 1e6,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
      }
    }
  };

  // Factory for the custom PowerMeter service (compatible with Homebridge Service usage)
  function PowerMeterService(displayName, subtype) {
    const svc = new Service(displayName, PowerMeterService.UUID, subtype);
    svc.addCharacteristic(EveCharacteristics.CurrentConsumption);
    svc.addOptionalCharacteristic(EveCharacteristics.TotalConsumption);
    svc.addOptionalCharacteristic(EveCharacteristics.Voltage);
    svc.addOptionalCharacteristic(EveCharacteristics.ElectricCurrent);
    return svc;
  }
  PowerMeterService.UUID = '00000001-0000-1777-8000-775D67EC4377';

  // ---------------- Platform and Accessory classes ----------------

  class EnergyMeterPlatform {
    constructor(log, config, platformApi) {
      this.log = log;
      this.api = platformApi || api;
      this.config = config || {};
      this.name = this.config.name || '3EM Energy Meter Platform';
      this.devices = Array.isArray(this.config.devices) ? this.config.devices : [];
      this.accessories = [];

      // register once Homebridge finished launching
      if (this.api && this.api.on) {
        this.api.on('didFinishLaunching', () => {
          this.log('3EM platform didFinishLaunching — creating devices from config...');
          this._createDevices();
        });
      } else {
        // In case api.on is not available (very unusual), create immediately
        this._createDevices();
      }
    }

    configureAccessory(accessory) {
      // Called when cached accessory is restored by Homebridge.
      this.log('Configuring cached accessory:', accessory.displayName);
      // We don't re-use the cached accessory object in this simplified implementation,
      // but a fuller implementation would attach to it here.
      this.accessories.push(accessory);
    }

    _createDevices() {
      this.devices.forEach((dev) => {
        try {
          const a = new EnergyMeterAccessory(this.log, dev, this.api);
          // keep local reference (this does not register with Homebridge cachedAccessories automatically)
          this.accessories.push(a);
          this.log('Created accessory for', dev.name || dev.ip);
        } catch (e) {
          this.log('Failed to create accessory for', dev.name || dev.ip, ':', e.message);
        }
      });
    }
  }

  class EnergyMeterAccessory {
    constructor(log, cfg, platformApi) {
      this.log = log;
      this.api = platformApi || api;
      this.config = cfg || {};

      this.name = this.config.name || 'Energy Meter';
      this.ip = this.config.ip;
      this.use_em = !!this.config.use_em;
      this.use_em_mode = Number.isInteger(this.config.use_em_mode) ? this.config.use_em_mode : 0;
      this.update_interval = this.config.update_interval || 10000;
      this.timeout = this.config.timeout || 5000;

      // Create the service & information
      this.service = PowerMeterService(this.name);
      this.informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
        .setCharacteristic(Characteristic.Model, this.use_em ? 'Shelly EM' : 'Shelly 3EM')
        .setCharacteristic(Characteristic.SerialNumber, this.ip || 'unknown');

      // Create fakegato history if available
      try {
        if (FakeGatoHistoryService) {
          this.loggingService = new FakeGatoHistoryService('energy', this, { storage: 'fs' });
        } else {
          this.loggingService = null;
        }
      } catch (e) {
        this.log('Fakegato init failed:', e.message);
        this.loggingService = null;
      }

      // Start polling
      this._pollTimer = setInterval(() => this._pollDevice(), Math.max(2000, this.update_interval));
      // immediate initial poll
      this._pollDevice();
    }

    getServices() {
      const arr = [this.informationService, this.service];
      if (this.loggingService) arr.push(this.loggingService);
      return arr;
    }

    _safeFloat(x) {
      const v = parseFloat(x);
      return isNaN(v) ? 0 : v;
    }

    _pollDevice() {
      if (!this.ip) {
        this.log('No IP configured for', this.name);
        return;
      }

      const http = require('http');
      const url = `http://${this.ip}/status`; // Shelly typically exposes emeter info here
      const req = http.get(url, { timeout: this.timeout }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            // Try emeters array first (Shelly EM/3EM)
            let meterData = null;

            if (json && Array.isArray(json.emeters) && json.emeters.length > 0) {
              if (this.use_em) {
                if (this.use_em_mode === 0) {
                  // combine first two channels if available
                  const a = json.emeters[0] || {};
                  const b = json.emeters[1] || {};
                  meterData = {
                    power: (this._safeFloat(a.power) + this._safeFloat(b.power)),
                    voltage: (this._safeFloat(a.voltage) + this._safeFloat(b.voltage)) / ( (a.voltage ? 1 : 0) + (b.voltage ? 1 : 0) || 1 ),
                    current: (this._safeFloat(a.current) + this._safeFloat(b.current)),
                    total: (this._safeFloat(a.total) + this._safeFloat(b.total))
                  };
                } else {
                  meterData = json.emeters[this.use_em_mode] || json.emeters[0];
                }
              } else {
                // 3EM: sum three phases if present
                const a = json.emeters[0] || {};
                const b = json.emeters[1] || {};
                const c = json.emeters[2] || {};
                meterData = {
                  power: (this._safeFloat(a.power) + this._safeFloat(b.power) + this._safeFloat(c.power)),
                  voltage: (this._safeFloat(a.voltage) + this._safeFloat(b.voltage) + this._safeFloat(c.voltage)) / ( (a.voltage ? 1 : 0) + (b.voltage ? 1 : 0) + (c.voltage ? 1 : 0) || 1 ),
                  current: (this._safeFloat(a.current) + this._safeFloat(b.current) + this._safeFloat(c.current)),
                  total: (this._safeFloat(a.total) + this._safeFloat(b.total) + this._safeFloat(c.total))
                };
              }
            } else {
              // fallback: check top-level fields (older firmware)
              meterData = {
                power: this._safeFloat(json.power),
                voltage: this._safeFloat(json.voltage),
                current: this._safeFloat(json.current),
                total: this._safeFloat(json.total)
              };
            }

            if (meterData) {
              const power = this._safeFloat(meterData.power);
              const voltage = this._safeFloat(meterData.voltage);
              const current = this._safeFloat(meterData.current);
              const totalKwh = this._safeFloat(meterData.total) / 1000.0; // Shelly total often in Wh

              // Update Eve characteristics (created earlier)
              try {
                this.service.getCharacteristic(EveCharacteristics.CurrentConsumption).updateValue(power);
                this.service.getCharacteristic(EveCharacteristics.Voltage).updateValue(voltage);
                this.service.getCharacteristic(EveCharacteristics.ElectricCurrent).updateValue(current);
                this.service.getCharacteristic(EveCharacteristics.TotalConsumption).updateValue(totalKwh);
              } catch (e) {
                // be defensive: if characteristics are missing, log debug
                this.log('Characteristic update error for', this.name, ':', e.message);
              }

              // Add to Fakegato if available
              if (this.loggingService && typeof this.loggingService.addEntry === 'function') {
                try {
                  this.loggingService.addEntry({ time: Math.round(Date.now() / 1000), power: Math.round(power) });
                } catch (err) {
                  // ignore history write errors
                }
              }
            }
          } catch (errJSON) {
            this.log('Failed to parse JSON from', this.ip, ':', errJSON.message);
          }
        });
      });

      req.on('error', (err) => {
        this.log('HTTP poll error for', this.name, '(', this.ip, '):', err.message);
      });

      req.on('timeout', () => {
        req.destroy();
        this.log('HTTP poll timeout for', this.name, '(', this.ip, ')');
      });
    }
  }

  // finally register the platform with Homebridge (plugin identifier should match package.json name)
  try {
    api.registerPlatform('homebridge-3em-energy-meter', '3EMEnergyMeter', EnergyMeterPlatform);
  } catch (e) {
    // fallback older api signature (2-arg)
    try {
      api.registerPlatform('3EMEnergyMeter', EnergyMeterPlatform);
    } catch (er) {
      // if registration fails, throw — plugin cannot continue
      throw er;
    }
  }
};