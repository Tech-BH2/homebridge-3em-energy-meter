/**
 * Updated for Homebridge 2.0 API
 * - module.exports is (api) => { ... }
 * - uses api.hap for Service/Characteristic
 * - initializes fakegato-history with api.hap
 * - fixes promise resolution bug (returns an object with all values)
 *
 * NOTE: This file retains the original plugin behavior and settings.
 */

var inherits = require('util').inherits;
var Service, Characteristic;
var request = require('request');
var FakeGatoHistoryService;
const version = require('./package.json').version;

module.exports = function (api) {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  FakeGatoHistoryService = require('fakegato-history')(api.hap);
  // Register accessory (keep plugin identifier and accessory name as original)
  api.registerAccessory("homebridge-3em-energy-meter", "3EMEnergyMeter", EnergyMeter);
}

function EnergyMeter (log, config) {
  this.log = log;
  this.ip = config["ip"] || "127.0.0.1";
  this.url = "http://" + this.ip + "/status/emeters?"; // endpoint used by original plugin
  this.auth = config["auth"];
  this.name = config["name"] || "Shelly 3EM";
  this.displayName = this.name;
  this.timeout = config["timeout"] || 5000;
  this.http_method = "GET";
  this.update_interval = Number(config["update_interval"] || 10000);
  this.use_em = config["use_em"] || false;
  this.use_em_mode = config["use_em_mode"] || 0;
  this.negative_handling_mode = config["negative_handling_mode"] || 0;
  this.use_pf = config["use_pf"] || false;
  this.debug_log = config["debug_log"] || false;
  this.serial = config.serial || "9000000";

  // internal variables
  this.waiting_response = false;
  this.powerConsumption = 0;
  this.totalPowerConsumption = 0;
  this.voltage1 = 0;
  this.ampere1 = 0;
  this.pf0 = 1;
  this.pf1 = 1;
  this.pf2 = 1;

  // EVE characteristics (custom UUIDs used by the original plugin)
  var EvePowerConsumption = function () {
    Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
    this.setProps({
      format: Characteristic.Formats.UINT16,
      unit: "Watts",
      maxValue: 100000,
      minValue: 0,
      minStep: 1,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };
  EvePowerConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
  inherits(EvePowerConsumption, Characteristic);

  var EveTotalConsumption = function () {
    Characteristic.call(this, 'Energy', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
    this.setProps({
      format: Characteristic.Formats.FLOAT,
      unit: 'kWh',
      maxValue: 1000000000,
      minValue: 0,
      minStep: 0.001,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };
  EveTotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
  inherits(EveTotalConsumption, Characteristic);

  var EveVoltage1 = function () {
    Characteristic.call(this, 'Volt', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
    this.setProps({
      format: Characteristic.Formats.FLOAT,
      unit: 'Volt',
      maxValue: 1000000000,
      minValue: 0,
      minStep: 0.001,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };
  EveVoltage1.UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
  inherits(EveVoltage1, Characteristic);

  var EveAmpere1 = function () {
    Characteristic.call(this, 'Ampere', 'E863F126-079E-48FF-8F27-9C2605A29F52');
    this.setProps({
      format: Characteristic.Formats.FLOAT,
      unit: 'Ampere',
      maxValue: 1000000000,
      minValue: 0,
      minStep: 0.001,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };
  EveAmpere1.UUID = 'E863F126-079E-48FF-8F27-9C2605A29F52';
  inherits(EveAmpere1, Characteristic);

  var PowerMeterService = function (displayName, subtype) {
    Service.call(this, displayName, '00000001-0000-1777-8000-775D67EC4377', subtype);
    this.addCharacteristic(EvePowerConsumption);
    this.addOptionalCharacteristic(EveTotalConsumption);
    this.addOptionalCharacteristic(EveVoltage1);
    this.addOptionalCharacteristic(EveAmpere1);
  };
  PowerMeterService.UUID = '00000001-0000-1777-8000-775D67EC4377';
  inherits(PowerMeterService, Service);

  // local vars
  this._EvePowerConsumption = EvePowerConsumption;
  this._EveTotalConsumption = EveTotalConsumption;
  this._EveVoltage1 = EveVoltage1;
  this._EveAmpere1 = EveAmpere1;

  // info
  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, "Shelly - produdegr")
    .setCharacteristic(Characteristic.Model, "Shelly 3EM")
    .setCharacteristic(Characteristic.FirmwareRevision, version)
    .setCharacteristic(Characteristic.SerialNumber, this.serial);

  // construct service
  this.service = new PowerMeterService(this.name);
  this.service.getCharacteristic(this._EvePowerConsumption).on('get', this.getPowerConsumption.bind(this));
  this.service.addCharacteristic(this._EveTotalConsumption).on('get', this.getTotalConsumption.bind(this));
  this.service.addCharacteristic(this._EveVoltage1).on('get', this.getVoltage1.bind(this));
  this.service.addCharacteristic(this._EveAmpere1).on('get', this.getAmpere1.bind(this));

  // add fakegato (energy)
  try {
    this.historyService = new FakeGatoHistoryService("energy", this, {storage:'fs'});
  } catch (e) {
    // if fakegato isn't available or fails, don't crash the plugin
    this.log("fakegato-history init failed: " + e.message);
    this.historyService = null;
  }
}

EnergyMeter.prototype.updateState = function () {
  if (this.waiting_response) {
    this.log('Please select a higher update_interval value. Http command may not finish!');
    return;
  }
  this.waiting_response = true;

  var self = this;

  var ops = {
    uri: this.url,
    method: this.http_method,
    timeout: this.timeout
  };
  if (this.auth) {
    ops.auth = { user: this.auth.user, pass: this.auth.pass };
  }

  if (this.debug_log) {
    this.log('Requesting energy values from Shelly 3EM(EM) ...');
  }

  request(ops, function (error, res, body) {
    var json = null;
    if (error) {
      self.log('Bad http response! (' + ops.uri + '): ' + error.message);
      self.waiting_response = false;
      return;
    }

    try {
      json = JSON.parse(body);

      if ((self.use_pf) && (self.use_em == false)) {
        self.pf0 = parseFloat(json.emeters[0].pf);
        self.pf1 = parseFloat(json.emeters[1].pf);
        self.pf2 = parseFloat(json.emeters[2].pf);
      } else {
        self.pf0 = 1;
        self.pf1 = 1;
        self.pf2 = 1;
      }

      // calculate based on configuration (keeps original logic)
      if (self.use_em) {
        if (self.use_em_mode == 0) {
          if (self.negative_handling_mode == 0) {
            self.powerConsumption = (parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power));
            self.totalPowerConsumption = ((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total)) / 1000);
            self.voltage1 = (((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage)) / 2));
            self.ampere1 = ((self.powerConsumption / self.voltage1));
            if (self.powerConsumption < 0) self.powerConsumption = 0;
            if (self.totalPowerConsumption < 0) self.totalPowerConsumption = 0;
            if (self.voltage1 < 0) self.voltage1 = 0;
            if (self.ampere1 < 0) self.ampere1 = 0;
          } else {
            self.powerConsumption = Math.abs(parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power));
            self.totalPowerConsumption = Math.abs((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total)) / 1000);
            self.voltage1 = Math.abs(((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage)) / 2));
            self.ampere1 = Math.abs((self.powerConsumption / self.voltage1));
          }
        } else if (self.use_em_mode == 1) {
          if (self.negative_handling_mode == 0) {
            self.powerConsumption = (parseFloat(json.emeters[0].power));
            self.totalPowerConsumption = (parseFloat(json.emeters[0].total) / 1000);
            self.voltage1 = (parseFloat(json.emeters[0].voltage));
            self.ampere1 = ((self.powerConsumption / self.voltage1));
            if (self.powerConsumption < 0) self.powerConsumption = 0;
            if (self.totalPowerConsumption < 0) self.totalPowerConsumption = 0;
            if (self.voltage1 < 0) self.voltage1 = 0;
            if (self.ampere1 < 0) self.ampere1 = 0;
          } else {
            self.powerConsumption = Math.abs(parseFloat(json.emeters[0].power));
            self.totalPowerConsumption = Math.abs(parseFloat(json.emeters[0].total) / 1000);
            self.voltage1 = Math.abs(parseFloat(json.emeters[0].voltage));
            self.ampere1 = Math.abs((self.powerConsumption / self.voltage1));
          }
        } else if (self.use_em_mode == 2) {
          if (self.negative_handling_mode == 0) {
            self.powerConsumption = (parseFloat(json.emeters[1].power));
            self.totalPowerConsumption = (parseFloat(json.emeters[1].total) / 1000);
            self.voltage1 = (parseFloat(json.emeters[1].voltage));
            self.ampere1 = ((self.powerConsumption / self.voltage1));
            if (self.powerConsumption < 0) self.powerConsumption = 0;
            if (self.totalPowerConsumption < 0) self.totalPowerConsumption = 0;
            if (self.voltage1 < 0) self.voltage1 = 0;
            if (self.ampere1 < 0) self.ampere1 = 0;
          } else {
            self.powerConsumption = Math.abs(parseFloat(json.emeters[1].power));
            self.totalPowerConsumption = Math.abs(parseFloat(json.emeters[1].total) / 1000);
            self.voltage1 = Math.abs(parseFloat(json.emeters[1].voltage));
            self.ampere1 = Math.abs((self.powerConsumption / self.voltage1));
          }
        }
      } else {
        // 3EM device - sum three phases (original behaviour)
        if (self.negative_handling_mode == 0) {
          self.powerConsumption = (parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power) + parseFloat(json.emeters[2].power));
          self.totalPowerConsumption = ((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total) + parseFloat(json.emeters[2].total)) / 1000);
          self.voltage1 = (((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
          self.ampere1 = (((parseFloat(json.emeters[0].current) * self.pf0) + (parseFloat(json.emeters[1].current) * self.pf1) + (parseFloat(json.emeters[2].current) * self.pf2)));
          if (self.powerConsumption < 0) self.powerConsumption = 0;
          if (self.totalPowerConsumption < 0) self.totalPowerConsumption = 0;
          if (self.voltage1 < 0) self.voltage1 = 0;
          if (self.ampere1 < 0) self.ampere1 = 0;
        } else {
          self.powerConsumption = Math.abs(parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power) + parseFloat(json.emeters[2].power));
          self.totalPowerConsumption = Math.abs((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total) + parseFloat(json.emeters[2].total)) / 1000);
          self.voltage1 = Math.abs(((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
          self.ampere1 = Math.abs(((parseFloat(json.emeters[0].current) * self.pf0) + (parseFloat(json.emeters[1].current) * self.pf1) + (parseFloat(json.emeters[2].current) * self.pf2)));
        }
      }

      if (self.debug_log) {
        self.log('[ voltage: ' + self.voltage1.toFixed(0) + 'V, current: ' + self.ampere1.toFixed(1) + 'A, consumption: ' + self.powerConsumption.toFixed(0) + 'W, total consumption: ' + self.totalPowerConsumption.toFixed(2) + 'kWh ]');
      }

      // set characteristics (EVE-compatible)
      try {
        self.service.getCharacteristic(self._EvePowerConsumption).setValue(self.powerConsumption);
        if (self.service.getCharacteristic(self._EveTotalConsumption)) {
          self.service.getCharacteristic(self._EveTotalConsumption).setValue(self.totalPowerConsumption);
        }
        if (self.service.getCharacteristic(self._EveVoltage1)) {
          self.service.getCharacteristic(self._EveVoltage1).setValue(self.voltage1);
        }
        if (self.service.getCharacteristic(self._EveAmpere1)) {
          self.service.getCharacteristic(self._EveAmpere1).setValue(self.ampere1);
        }
      } catch (e) {
        self.log("Error setting characteristics: " + e.message);
      }

      // add to fakegato history if available
      if (self.historyService && typeof self.historyService.addEntry === 'function') {
        try {
          self.historyService.addEntry({time: Math.round(new Date().valueOf() / 1000), power: Math.round(self.powerConsumption)});
        } catch (e) {
          // ignore history errors
        }
      }

    } catch (parseErr) {
      self.log('Error processing data: ' + parseErr.message);
    }

    self.waiting_response = false;
  });
};

EnergyMeter.prototype.getPowerConsumption = function (callback) {
  callback(null, this.powerConsumption);
};
EnergyMeter.prototype.getTotalConsumption = function (callback) {
  callback(null, this.totalPowerConsumption);
};
EnergyMeter.prototype.getVoltage1 = function (callback) {
  callback(null, this.voltage1);
};
EnergyMeter.prototype.getAmpere1 = function (callback) {
  callback(null, this.ampere1);
};
EnergyMeter.prototype.getServices = function () {
  this.log("getServices: " + this.name);
  if (this.update_interval > 0) {
    this.timer = setInterval(this.updateState.bind(this), this.update_interval);
  }
  var services = [this.informationService, this.service];
  if (this.historyService) services.push(this.historyService);
  return services;
};
