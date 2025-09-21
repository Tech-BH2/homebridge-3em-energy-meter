const inherits = require('util').inherits;
const request = require('request');
const version = require('./package.json').version;

let Service, Characteristic, FakeGatoHistoryService;
let EvePowerConsumption, EveTotalConsumption, EveVoltage;

// =====================
// Custom Eve Characteristics
// =====================
class EvePowerConsumptionClass extends Characteristic {
    constructor() {
        super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
            format: 'uint16',
            unit: 'W',
            maxValue: 100000,
            minValue: 0,
            minStep: 1,
            perms: ['pr','ev']
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
            perms: ['pr','ev']
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
            perms: ['pr','ev']
        });
        this.value = this.getDefaultValue();
    }
}
EveVoltage = EveVoltageClass;

// =====================
// EnergyMeter Accessory
// =====================
function EnergyMeter(log, config, api) {
    this.log = log;
    this.ip = config.ip || '127.0.0.1';
    this.url = `http://${this.ip}/status/emeters?`;
    this.auth = config.auth;
    this.name = config.name || '3EM Energy';
    this.timeout = config.timeout || 5000;
    this.http_method = 'GET';
    this.update_interval = Number(config.update_interval || 10000);
    this.debug_log = config.debug_log || false;
    this.serial = config.serial || '9000000';

    this.waiting_response = false;
    this.powerConsumption = 0;
    this.totalPowerConsumption = 0;
    this.voltage1 = 0;

    this.energyService = new Service.Lightbulb(this.name + ' Energy');
    this.energyService.addCharacteristic(EvePowerConsumption);
    this.energyService.addCharacteristic(EveTotalConsumption);
    this.energyService.addCharacteristic(EveVoltage);

    setInterval(() => { this.updateState && this.updateState(); }, this.update_interval);
    try { this.updateState && this.updateState(); } catch(e) { this.log('Initial updateState failed: ' + e.message); }
}

EnergyMeter.prototype.getServices = function() {
    const informationService = new Service.AccessoryInformation();
    informationService
        .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
        .setCharacteristic(Characteristic.Model, '3EM')
        .setCharacteristic(Characteristic.SerialNumber, this.serial)
        .setCharacteristic(Characteristic.FirmwareRevision, version);

    return [informationService, this.energyService];
};

EnergyMeter.prototype.updateState = function() {
    if (this.waiting_response) return;
    this.waiting_response = true;

    const ops = { uri: this.url, method: this.http_method, timeout: this.timeout };
    if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };

    request(ops, (error, res, body) => {
        this.waiting_response = false;
        if (error) return this.log('HTTP request failed: ' + error.message);
        try {
            const json = JSON.parse(body);
            let power = 0, total = 0, voltage = 0;
            if (Array.isArray(json.emeters)) {
                json.emeters.forEach(e => {
                    power += parseFloat(e.power || 0);
                    total += parseFloat(e.total || 0);
                    voltage += parseFloat(e.voltage || 0);
                });
                total = total / 1000;
                voltage = voltage / json.emeters.length;
            }
            this.powerConsumption = power;
            this.totalPowerConsumption = total;
            this.voltage1 = voltage;

            this.energyService.updateCharacteristic(EvePowerConsumption, Math.round(this.powerConsumption));
            this.energyService.updateCharacteristic(EveTotalConsumption, Number(this.totalPowerConsumption));
            this.energyService.updateCharacteristic(EveVoltage, Number(this.voltage1));

        } catch(e) { this.log('updateState parse error: ' + e.message); }
    });
};

// =====================
// EnergyOnly Accessory
// =====================
function EnergyOnly(log, config, api) {
    this.log = log;
    this.ip = config.ip || '127.0.0.1';
    this.url = `http://${this.ip}/status/emeters?`;
    this.auth = config.auth;
    this.name = config.name || 'Energy ' + this.ip;

    this.powerConsumption = 0;
    this.totalPowerConsumption = 0;
    this.voltage1 = 0;

    this.service = new Service.Lightbulb(this.name);
    this.service.addCharacteristic(EvePowerConsumption);
    this.service.addCharacteristic(EveTotalConsumption);
    this.service.addCharacteristic(EveVoltage);

    setInterval(() => { this.updateState && this.updateState(); }, 10000);
}

EnergyOnly.prototype.getServices = function() {
    const info = new Service.AccessoryInformation();
    info.setCharacteristic(Characteristic.Manufacturer, 'Shelly')
        .setCharacteristic(Characteristic.Model, '3EM-energy-only')
        .setCharacteristic(Characteristic.SerialNumber, 'unknown')
        .setCharacteristic(Characteristic.FirmwareRevision, version);

    return [info, this.service];
};

EnergyOnly.prototype.updateState = function() {
    const ops = { uri: this.url, method: 'GET', timeout: 5000 };
    if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };

    request(ops, (error, res, body) => {
        if (error) return this.log('EnergyOnly request failed: ' + error.message);
        try {
            const json = JSON.parse(body);
            let power = 0, total = 0, voltage = 0;
            if (Array.isArray(json.emeters)) {
                json.emeters.forEach(e => {
                    power += parseFloat(e.power || 0);
                    total += parseFloat(e.total || 0);
                    voltage += parseFloat(e.voltage || 0);
                });
                total = total / 1000;
                voltage = voltage / json.emeters.length;
            }
            this.powerConsumption = power;
            this.totalPowerConsumption = total;
            this.voltage1 = voltage;

            this.service.updateCharacteristic(EvePowerConsumption, Math.round(power));
            this.service.updateCharacteristic(EveTotalConsumption, total);
            this.service.updateCharacteristic(EveVoltage, voltage);

        } catch(e) { this.log('EnergyOnly parse error: ' + e.message); }
    });
};

// =====================
// Platform for split channel logic
// =====================
function ThreeEmPlatform(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.cachedAccessories = {};

    if (api && api.on) api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
}

ThreeEmPlatform.prototype.configureAccessory = function(accessory) {
    this.cachedAccessories[accessory.UUID] = accessory;
};

ThreeEmPlatform.prototype.didFinishLaunching = function() {
    if (!this.config.devices) return;

    this.config.devices.forEach(device => {
        const uuid = this.api.hap.uuid.generate(device.ip);

        if (this.cachedAccessories[uuid]) {
            this.log('Restoring cached accessory: ' + device.name);
        } else {
            this.log('Adding new accessory: ' + device.name);
            const accessory = new EnergyOnly(this.log, device, this.api);
            this.api.registerAccessory('3EMEnergyMeterEnergy', accessory);
        }
    });
};

// =====================
// Plugin registration
// =====================
module.exports = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    FakeGatoHistoryService = require('fakegato-history')(api);

    api.registerAccessory('3EMEnergyMeter', EnergyMeter);
    api.registerAccessory('3EMEnergyMeterEnergy', EnergyOnly);
    api.registerPlatform('3EMEnergyMeterPlatform', ThreeEmPlatform);
};