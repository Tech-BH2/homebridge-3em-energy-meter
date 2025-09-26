/**
 * Updated for Homebridge 2.0 API with Fakegato compatibility fix
 * - Proper fakegato-history init (Service + Characteristic passed explicitly)
 * - Defensive guards for undefined JSON fields
 * - Accessory registration remains (works if placed under "accessories" in config.json)
 */

var inherits = require('util').inherits;
var Service, Characteristic;
var request = require('request');
var FakeGatoHistoryService;
const version = require('./package.json').version;

module.exports = function (api) {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  FakeGatoHistoryService = require('fakegato-history')({
    hap: api.hap,
    Service: api.hap.Service,
    Characteristic: api.hap.Characteristic
  });
  api.registerAccessory("homebridge-3em-energy-meter", "3EMEnergyMeter", EnergyMeter);
}

function EnergyMeter (log, config) {
  this.log = log;
  this.ip = config["ip"] || "127.0.0.1";
  this.url = "http://" + this.ip + "/status/emeters?";
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

  this.waiting_response = false;
  this.powerConsumption = 0;
  this.totalPowerConsumption = 0;
  this.voltage1 = 0;
  this.ampere1 = 0;
  this.pf0 = 1;
  this.pf1 = 1;
  this.pf2 = 1;

  // Eve custom characteristics
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

  this._EvePowerConsumption = EvePowerConsumption;
  this._EveTotalConsumption = EveTotalConsumption;
  this._EveVoltage1 = EveVoltage1;
  this._EveAmpere1 = EveAmpere1;

  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, "Shelly - produdegr")
    .setCharacteristic(Characteristic.Model, "Shelly 3EM/EM")
    .setCharacteristic(Characteristic.FirmwareRevision, version)
    .setCharacteristic(Characteristic.SerialNumber, this.serial);

  this.service = new PowerMeterService(this.name);
  this.service.getCharacteristic(this._EvePowerConsumption).on('get', this.getPowerConsumption.bind(this));
  this.service.addCharacteristic(this._EveTotalConsumption).on('get', this.getTotalConsumption.bind(this));
  this.service.addCharacteristic(this._EveVoltage1).on('get', this.getVoltage1.bind(this));
  this.service.addCharacteristic(this._EveAmpere1).on('get', this.getAmpere1.bind(this));

  try {
    this.historyService = new FakeGatoHistoryService("energy", this, {storage:'fs'});
  } catch (e) {
    this.log("fakegato-history init failed: " + e.message);
    this.historyService = null;
  }
}

EnergyMeter.prototype.updateState = function () {
  if (this.waiting_response) return;
  this.waiting_response = true;

  var self = this;
  var ops = {
    uri: this.url,
    method: this.http_method,
    timeout: this.timeout
  };
  if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };

  request(ops, function (error, res, body) {
    if (error) {
      self.log('HTTP error: ' + error.message);
      self.waiting_response = false;
      return;
    }

    try {
      var json = JSON.parse(body);
      if (!json || !json.emeters) throw new Error("Invalid JSON response");

      // defaults
      var pwr = 0, tot = 0, volt = 0, amp = 0;

      if (self.use_em) {
        var emIndex = self.use_em_mode; // 0 = combine, 1 or 2 = single channel
        if (emIndex === 0 && json.emeters.length >= 2) {
          pwr = parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power);
          tot = (parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total)) / 1000;
          volt = (parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage)) / 2;
          amp = volt ? pwr / volt : 0;
        } else if (json.emeters[emIndex]) {
          pwr = parseFloat(json.emeters[emIndex].power);
          tot = parseFloat(json.emeters[emIndex].total) / 1000;
          volt = parseFloat(json.emeters[emIndex].voltage);
          amp = volt ? pwr / volt : 0;
        }
      } else if (json.emeters.length >= 3) {
        pwr = parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power) + parseFloat(json.emeters[2].power);
        tot = (parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total) + parseFloat(json.emeters[2].total)) / 1000;
        volt = (parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3;
        amp = (parseFloat(json.emeters[0].current) + parseFloat(json.emeters[1].current) + parseFloat(json.emeters[2].current));
      }

      if (self.negative_handling_mode === 0) {
        if (pwr < 0) pwr = 0;
        if (tot < 0) tot = 0;
        if (volt < 0) volt = 0;
        if (amp < 0) amp = 0;
      } else {
        pwr = Math.abs(pwr);
        tot = Math.abs(tot);
        volt = Math.abs(volt);
        amp = Math.abs(amp);
      }

      self.powerConsumption = isNaN(pwr) ? 0 : pwr;
      self.totalPowerConsumption = isNaN(tot) ? 0 : tot;
      self.voltage1 = isNaN(volt) ? 0 : volt;
      self.ampere1 = isNaN(amp) ? 0 : amp;

      self.service.getCharacteristic(self._EvePowerConsumption).updateValue(self.powerConsumption);
      self.service.getCharacteristic(self._EveTotalConsumption).updateValue(self.totalPowerConsumption);
      self.service.getCharacteristic(self._EveVoltage1).updateValue(self.voltage1);
      self.service.getCharacteristic(self._EveAmpere1).updateValue(self.ampere1);

      if (self.historyService) {
        self.historyService.addEntry({time: Math.round(new Date().valueOf() / 1000), power: Math.round(self.powerConsumption)});
      }

    } catch (e) {
      self.log("Parse error: " + e.message);
    }
    self.waiting_response = false;
  });
};

EnergyMeter.prototype.getPowerConsumption = function (cb) { cb(null, this.powerConsumption); };
EnergyMeter.prototype.getTotalConsumption = function (cb) { cb(null, this.totalPowerConsumption); };
EnergyMeter.prototype.getVoltage1 = function (cb) { cb(null, this.voltage1); };
EnergyMeter.prototype.getAmpere1 = function (cb) { cb(null, this.ampere1); };

EnergyMeter.prototype.getServices = function () {
  if (this.update_interval > 0) {
    this.timer = setInterval(this.updateState.bind(this), this.update_interval);
  }
  var services = [this.informationService, this.service];
  if (this.historyService) services.push(this.historyService);
  return services;
};
