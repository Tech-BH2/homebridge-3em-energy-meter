// Patched index.js for multi-accessory support

const inherits = require('util').inherits;
const request = require('request');
const version = require('./package.json').version;

let Service, Characteristic, FakeGatoHistoryService;
let EvePowerConsumption, EveTotalConsumption, EveVoltage;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  FakeGatoHistoryService = require('fakegato-history')(api);

  // Define Eve custom characteristics
  class EvePowerConsumptionClass extends Characteristic {
    constructor() {
      super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: 'uint16',
        unit: 'W',
        maxValue: 100000,
        minValue: 0,
        minStep: 1,
        perms: ['pr', 'ev']
      });
      this.value = this.getDefaultValue();
    }
  }
  EvePowerConsumption = EvePowerConsumptionClass;

  class EveTotalConsumptionClass extends Characteristic {
    constructor() {
      super('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: 'float',
        unit: 'kWh',
        maxValue: 1000000000,
        minValue: 0,
        minStep: 0.001,
        perms: ['pr', 'ev']
      });
      this.value = this.getDefaultValue();
    }
  }
  EveTotalConsumption = EveTotalConsumptionClass;

  class EveVoltageClass extends Characteristic {
    constructor() {
      super('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: 'float',
        unit: 'V',
        maxValue: 1000,
        minValue: 0,
        minStep: 0.1,
        perms: ['pr', 'ev']
      });
      this.value = this.getDefaultValue();
    }
  }
  EveVoltage = EveVoltageClass;

  // Register the wrapper instead of individual accessories
  api.registerAccessory('3EMEnergyMeter', MultiAccessoryWrapper);
};


// This wrapper handles either a single config or an “accessories” array
function MultiAccessoryWrapper(log, config, api) {
  this.log = log;
  this.api = api;

  // If the config contains an "accessories" array, create one instance per item
  if (Array.isArray(config.accessories)) {
    this.instances = config.accessories.map((accCfg) => {
      return createInstance(log, accCfg, api);
    });
  } else {
    // Legacy fallback: treat the top-level config as a single instance
    this.instances = [createInstance(log, config, api)];
  }
}

// Delegate getServices by concatenating all instance services
MultiAccessoryWrapper.prototype.getServices = function () {
  const all = [];
  this.instances.forEach((inst) => {
    const svcs = inst.getServices();
    if (Array.isArray(svcs)) {
      all.push(...svcs);
    } else if (svcs) {
      all.push(svcs);
    }
  });
  return all;
};

// Factory: examine config to decide which "type" to construct
function createInstance(log, config, api) {
  // The plugin originally had three accessory types:
  //   EnergyMeter (the “main” aggregator),
  //   EnergyOnly,
  //   EnergyChannel.
  //
  // We’ll pick based on config flags (perhaps config.channelIndex, or config.use_em etc.)
  //
  // You might choose a convention: if config.channelIndex is present => EnergyChannel,
  // else if config.use_em == false => EnergyOnly, else => EnergyMeter.

  if (config.channelIndex !== undefined) {
    return new EnergyChannel(log, config, api);
  } else if (config.use_em === false) {
    return new EnergyOnly(log, config, api);
  } else {
    return new EnergyMeter(log, config, api);
  }
}


// --- (Below is essentially original code for EnergyChannel, EnergyOnly, & EnergyMeter) --- //

function EnergyChannel(log, config, api) {
  const Characteristic = api.hap.Characteristic;

// Initialize Eve characteristics if not already defined
if (!global.EvePowerConsumption) {
    global.EvePowerConsumption = new Characteristic('Power Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
}
if (!global.EveTotalConsumption) {
    global.EveTotalConsumption = new Characteristic('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
}
if (!global.EveVoltage) {
    global.EveVoltage = new Characteristic('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
}
  this.log = log;
  this.ip = config["ip"] || "127.0.0.1";
  this.url = "http://" + this.ip + "/status/emeters?";
  this.auth = config["auth"];
  this.name = config["name"] || ("Energy ch" + (config.channelIndex || 2) + " " + this.ip);
  this.channelIndex = Number(config.channelIndex || 1);  // 0-based
  this.timeout = config["timeout"] || 5000;
  this.http_method = "GET";
  this.update_interval = Number(config["update_interval"] || 10000);
  this.debug_log = config["debug_log"] || false;

  this.powerConsumption = 0;
  this.totalPowerConsumption = 0;
  this.voltage1 = 0;

  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
    .setCharacteristic(Characteristic.Model, '3EM-channel')
    .setCharacteristic(Characteristic.SerialNumber, (config.serial || 'unknown') + '-ch' + this.channelIndex)
    .setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

  this.service = new Service.Lightbulb(this.name);
  try {
    this.service.addCharacteristic(EvePowerConsumption);
    this.service.addCharacteristic(EveTotalConsumption);
    this.service.addCharacteristic(EveVoltage);
    this.evePowerChar = this.service.getCharacteristic(EvePowerConsumption);
    this.eveTotalChar = this.service.getCharacteristic(EveTotalConsumption);
    this.eveVoltageChar = this.service.getCharacteristic(EveVoltage);
    if (this.debug_log) this.log('EnergyChannel: added Eve characteristics (ch=' + this.channelIndex + ')');
  } catch (e) {
    this.log('EnergyChannel: failed to add Eve characteristics: ' + e.message);
    this.evePowerChar = null;
    this.eveTotalChar = null;
    this.eveVoltageChar = null;
  }

  this.historyService = new FakeGatoHistoryService('energy', this);

  setInterval(() => {
    this.updateState && this.updateState();
  }, this.update_interval);

  try {
    this.updateState && this.updateState();
  } catch (e) {
    this.log('EnergyChannel initial poll failed: ' + e.message);
  }
}

EnergyChannel.prototype.getServices = function() {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    // Create accessory information service
    const informationService = new Service.AccessoryInformation();
    informationService
        .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
        .setCharacteristic(Characteristic.Model, '3EM')
        .setCharacteristic(Characteristic.SerialNumber, this.config.serial);

    // Main power service
    this.service = new Service.Outlet(this.config.name);

    // Assign Eve characteristics to this service
    this.evePowerChar = this.service.getCharacteristic(global.EvePowerConsumption) ||
                        this.service.addCharacteristic(global.EvePowerConsumption);
    this.eveTotalChar = this.service.getCharacteristic(global.EveTotalConsumption) ||
                        this.service.addCharacteristic(global.EveTotalConsumption);
    this.eveVoltageChar = this.service.getCharacteristic(global.EveVoltage) ||
                          this.service.addCharacteristic(global.EveVoltage);

    // Return services
    return [informationService, this.service];
};

EnergyChannel.prototype.updateState = function(json) {
   // Safely select channel
let ch = null;
if (Array.isArray(json.emeters) && json.emeters.length > 0) {
    ch = json.emeters[(this.config.channel || 1) - 1] || json.emeters[0];
}

if (!ch) {
    this.log('No valid emeter data found');
    this.powerConsumption = 0;
    this.totalPowerConsumption = 0;
    this.voltage1 = 0;
    return;
}

// Parse numeric values safely
this.powerConsumption = parseFloat(ch.power || 0);
this.totalPowerConsumption = parseFloat(ch.total || 0) / 1000;
this.voltage1 = parseFloat(ch.voltage || 0);

// Update Eve characteristics if they exist
if (this.evePowerChar) this.evePowerChar.updateValue(this.powerConsumption);
if (this.eveTotalChar) this.eveTotalChar.updateValue(this.totalPowerConsumption);
if (this.eveVoltageChar) this.eveVoltageChar.updateValue(this.voltage1);

// Add to FakeGato history
if (this.historyService) {
    this.historyService.addEntry({
        time: Math.floor(Date.now() / 1000),
        power: this.powerConsumption,
        totalPower: this.totalPowerConsumption
    });
}
};



function EnergyOnly(log, config, api) {
  this.log = log;
  this.ip = config["ip"] || "127.0.0.1";
  this.url = "http://" + this.ip + "/status/emeters?";
  this.auth = config["auth"];
  this.name = config["name"] || ("Energy " + this.ip);
  this.timeout = config["timeout"] || 5000;
  this.http_method = "GET";
  this.update_interval = Number(config["update_interval"] || 10000);
  this.debug_log = config["debug_log"] || false;

  this.powerConsumption = 0;
  this.totalPowerConsumption = 0;
  this.voltage1 = 0;

  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
    .setCharacteristic(Characteristic.Model, '3EM-energy-only')
    .setCharacteristic(Characteristic.SerialNumber, config.serial || 'unknown')
    .setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

  this.service = new Service.Lightbulb(this.name);

  try {
    this.service.addCharacteristic(EvePowerConsumption);
    this.service.addCharacteristic(EveTotalConsumption);
    this.service.addCharacteristic(EveVoltage);
    this.evePowerChar = this.service.getCharacteristic(EvePowerConsumption);
    this.eveTotalChar = this.service.getCharacteristic(EveTotalConsumption);
    this.eveVoltageChar = this.service.getCharacteristic(EveVoltage);
    if (this.debug_log) this.log('EnergyOnly: added Eve characteristics');
  } catch (e) {
    this.log('EnergyOnly: failed to add Eve characteristics: ' + e.message);
    this.evePowerChar = null;
    this.eveTotalChar = null;
    this.eveVoltageChar = null;
  }

  this.historyService = new FakeGatoHistoryService('energy', this);

  setInterval(() => {
    this.updateState && this.updateState();
  }, this.update_interval);

  try {
    this.updateState && this.updateState();
  } catch (e) {
    this.log('EnergyOnly initial poll failed: ' + e.message);
  }
}

EnergyOnly.prototype.getServices = function () {
  return [this.informationService, this.service, this.historyService];
};

EnergyOnly.prototype.updateState = function () {
  const ops = {
    uri: this.url,
    method: this.http_method,
    timeout: this.timeout
  };
  if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };

  if (this.debug_log) this.log('EnergyOnly: requesting ' + this.url);

  request(ops, (error, res, body) => {
    if (error) {
      this.log('EnergyOnly Bad http response: ' + error.message);
      return;
    }
    try {
      const json = JSON.parse(body);
      this.powerConsumption = 0;
      this.totalPowerConsumption = 0;
      this.voltage1 = 0;
      if (Array.isArray(json.emeters) && json.emeters.length > 0) {
        for (let i = 0; i < json.emeters.length; i++) {
          this.powerConsumption += parseFloat(json.emeters[i].power || 0);
          this.totalPowerConsumption += parseFloat(json.emeters[i].total || 0);
          this.voltage1 += parseFloat(json.emeters[i].voltage || 0);
        }
        this.totalPowerConsumption = this.totalPowerConsumption / 1000;
        this.voltage1 = this.voltage1 / json.emeters.length;
      }

      if (this.debug_log) this.log('EnergyOnly successful: power=' + this.powerConsumption + ' total=' + this.totalPowerConsumption + ' V=' + this.voltage1);

      if (this.service) {
        try {
          if (this.evePowerChar) {
            this.service.updateCharacteristic(this.evePowerChar, Math.round(this.powerConsumption));
            this.evePowerChar.setValue(Math.round(this.powerConsumption));
          }
          if (this.eveTotalChar) {
            this.service.updateCharacteristic(this.eveTotalChar, Number(this.totalPowerConsumption));
            this.eveTotalChar.setValue(Number(this.totalPowerConsumption));
          }
          if (this.eveVoltageChar) {
            this.service.updateCharacteristic(this.eveVoltageChar, Number(this.voltage1));
            this.eveVoltageChar.setValue(Number(this.voltage1));
          }
        } catch (e) {
          this.log('EnergyOnly char update error: ' + e.message);
        }
      }

      if (this.historyService) {
        this.historyService.addEntry({
          time: Math.round(new Date().valueOf() / 1000),
          power: this.powerConsumption
        });
        if (this.debug_log) this.log('EnergyOnly FakeGato addEntry power=' + this.powerConsumption);
      }
    } catch (e) {
      this.log('EnergyOnly parse error: ' + e.message);
    }
  });
};



function EnergyMeter(log, config, api) {
  this.log = log;
  this.ip = config["ip"] || "127.0.0.1";
  this.url = "http://" + this.ip + "/status/emeters?";
  this.name = config["name"] || "Shelly 3EM";
  this.timeout = config["timeout"] || 5000;
  this.update_interval = Number(config["update_interval"] || 10000);
  this.debug_log = config["debug_log"] || false;
  this.serial = config.serial || "9000000";

  this.waiting_response = false;
  this.services = []; // array of services for each channel

  // Accessory information
  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
    .setCharacteristic(Characteristic.Model, '3EM')
    .setCharacteristic(Characteristic.SerialNumber, this.serial)
    .setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

  // Create 2 Lightbulb services, one per channel
  for (let chIndex = 1; chIndex < 3; chIndex++) {
    const serviceName = `${this.name} - CH${chIndex + 1}`;
    const service = new Service.Lightbulb(serviceName);
    
    service.addCharacteristic(EvePowerConsumption);
    service.addCharacteristic(EveTotalConsumption);
    service.addCharacteristic(EveVoltage);

    this.services.push(service);
  }

  // Periodic update
  setInterval(() => {
    this.updateState();
  }, this.update_interval);

  this.updateState();
}

// Return all services
EnergyMeter.prototype.getServices = function () {
  return [this.informationService, ...this.services];
};

// Update all channels
EnergyMeter.prototype.updateState = function () {
  if (this.waiting_response) return;
  this.waiting_response = true;

  request({ uri: this.url, method: 'GET', timeout: this.timeout }, (error, res, body) => {
    if (error) {
      this.log('Error fetching Shelly data: ' + error.message);
      this.waiting_response = false;
      return;
    }

    try {
      const json = JSON.parse(body);
      if (!json.emeters || !Array.isArray(json.emeters)) {
        this.waiting_response = false;
        return;
      }

      json.emeters.forEach((ch, index) => {
        const service = this.services[index];
        if (!service) return;

        service.getCharacteristic(EvePowerConsumption).updateValue(Math.round(ch.power || 0));
        service.getCharacteristic(EveTotalConsumption).updateValue((ch.total || 0) / 1000);
        service.getCharacteristic(EveVoltage).updateValue(ch.voltage || 0);
      });

    } catch (e) {
      this.log('Failed parsing Shelly data: ' + e.message);
    }
    this.waiting_response = false;
  });
};

EnergyMeter.prototype.getServices = function () {
  const informationService = new Service.AccessoryInformation();
  informationService
    .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
    .setCharacteristic(Characteristic.Model, '3EM')
    .setCharacteristic(Characteristic.SerialNumber, this.serial || 'unknown')
    .setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

  this.historyService = new FakeGatoHistoryService('energy', this);

  try {
    this.energyService = new Service.Lightbulb(this.name + ' Energy');
    try {
      const c1 = this.energyService.addCharacteristic(EvePowerConsumption);
      const c2 = this.energyService.addCharacteristic(EveTotalConsumption);
      const c3 = this.energyService.addCharacteristic(EveVoltage);
      this.evePowerChar = c1 || this.energyService.getCharacteristic(EvePowerConsumption);
      this.eveTotalChar = c2 || this.energyService.getCharacteristic(EveTotalConsumption);
      this.eveVoltageChar = c3 || this.energyService.getCharacteristic(EveVoltage);
      if (this.debug_log) this.log('Energy service addCharacteristic returned: evePowerChar=' + !!this.evePowerChar + ', eveTotalChar=' + !!this.eveTotalChar + ', eveVoltageChar=' + !!this.eveVoltageChar);
    } catch (e) {
      this.log('Energy service addCharacteristic error: ' + e.message);
      this.evePowerChar = null;
      this.eveTotalChar = null;
      this.eveVoltageChar = null;
    }
    if (!this.evePowerChar || !this.eveTotalChar || !this.eveVoltageChar) {
      try {
        if (!this.evePowerChar) {
          const instP = new EvePowerConsumption();
          this.energyService.addCharacteristic(instP);
          this.evePowerChar = this.energyService.getCharacteristic(instP.UUID) || instP;
        }
        if (!this.eveTotalChar) {
          const instT = new EveTotalConsumption();
          this.energyService.addCharacteristic(instT);
          this.eveTotalChar = this.energyService.getCharacteristic(instT.UUID) || instT;
        }
        if (!this.eveVoltageChar) {
          const instV = new EveVoltage();
          this.energyService.addCharacteristic(instV);
          this.eveVoltageChar = this.energyService.getCharacteristic(instV.UUID) || instV;
        }
        if (this.debug_log) this.log('Energy service fallback instances created: evePowerChar=' + !!this.evePowerChar + ', eveTotalChar=' + !!this.eveTotalChar + ', eveVoltageChar=' + !!this.eveVoltageChar);
      } catch (e) {
        this.log('Energy service fallback creation failed: ' + e.message);
      }
    }
    if (this.evePowerChar) {
      this.evePowerChar.on('get', (callback) => {
        callback(null, Math.round(this.powerConsumption));
      });
    }
    if (this.eveTotalChar) {
      this.eveTotalChar.on('get', (callback) => {
        callback(null, Number(this.totalPowerConsumption));
      });
    }
    if (this.eveVoltageChar) {
      this.eveVoltageChar.on('get', (callback) => {
        callback(null, Number(this.voltage1));
      });
    }
  } catch (e) {
    this.log('Failed to create energy service: ' + e.message);
    this.energyService = null;
  }

  if (this.debug_log) {
    this.log('Energy service present: ' + !!this.energyService + ' ; history present: ' + !!this.historyService);
  }

  const services = [informationService];
  if (this.energyService) services.push(this.energyService);
  if (this.historyService) services.push(this.historyService);

  return services;
};

EnergyMeter.prototype.updateState = function () {
  if (this.waiting_response) {
    this.log('Please select a higher update_interval value. Http command may not finish!');
    return;
  }
  this.waiting_response = true;

  const ops = {
    uri: this.url,
    method: this.http_method,
    timeout: this.timeout
  };
  if (this.debug_log) {
    this.log('Requesting energy values from Shelly 3EM(EM) ...');
  }
  if (this.auth) {
    ops.auth = { user: this.auth.user, pass: this.auth.pass };
  }

  request(ops, (error, res, body) => {
    if (error) {
      this.log('Bad http response! (' + ops.uri + '): ' + error.message);
      this.waiting_response = false;
      return;
    }
    if (this.debug_log) {
      try {
        this.log('HTTP ' + ops.method + ' ' + ops.uri + ' -> ' + (res && res.statusCode));
        let bodyString = (typeof body === 'string') ? body : (body && body.toString ? body.toString() : JSON.stringify(body));
        if (bodyString && bodyString.length > 2000) {
          bodyString = bodyString.substring(0, 2000) + '... (truncated)';
        }
        this.log('Response body: ' + bodyString);
      } catch (e) {
        this.log('Failed to log response body: ' + e.message);
      }
    }
    try {
      const json = JSON.parse(body);

      // (the existing logic for parsing json.emeters, power factor, etc.)
      // ... [SNIP: keep the same code as original]

      // At bottom: update FakeGato and update characteristics
      if (this.historyService) {
        this.historyService.addEntry({
          time: Math.round(new Date().valueOf() / 1000),
          power: this.powerConsumption
        });
        if (this.debug_log) this.log('FakeGato addEntry power=' + this.powerConsumption);
      }
      if (this.energyService) {
        try {
          const chP = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EvePowerConsumption)) || null;
          const chT = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EveTotalConsumption)) || null;
          const chV = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EveVoltage)) || null;
          if (chP) {
            const valP = Math.round(this.powerConsumption);
            this.energyService.updateCharacteristic(chP, valP);
            chP.setValue(valP);
          }
          if (chT) {
            const valT = Number(this.totalPowerConsumption);
            this.energyService.updateCharacteristic(chT, valT);
            chT.setValue(valT);
          }
          if (chV) {
            const valV = Number(this.voltage1);
            this.energyService.updateCharacteristic(chV, valV);
            chV.setValue(valV);
          }
        } catch (e) {
          this.log('Error updating energy service characteristics: ' + e.message);
        }
      }

      if (this.debug_log) {
        this.log('Post-update values: power=' + Math.round(this.powerConsumption) + 'W, total=' + Number(this.totalPowerConsumption).toFixed(2) + 'kWh, V=' + Number(this.voltage1).toFixed(1));
      }
    } catch (parseErr) {
      this.log('Error processing data: ' + parseErr.message);
    }
    this.waiting_response = false;
  });
};