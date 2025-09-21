
const inherits = require('util').inherits;
const request = require('request');
const version = require('./package.json').version;

let Service, Characteristic, FakeGatoHistoryService;
let EvePowerConsumption, EveTotalConsumption, EveVoltage;

module.exports = (api) => {
	Service = api.hap.Service;
	Characteristic = api.hap.Characteristic;
	FakeGatoHistoryService = require('fakegato-history')(api);

	class EvePowerConsumptionClass extends Characteristic {
		constructor() {
			super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
			this.setProps({ format: 'uint16', unit: 'W', maxValue: 100000, minValue: 0, minStep: 1, perms: ['pr','ev'] });
			this.value = this.getDefaultValue();
		}
	}
	EvePowerConsumption = EvePowerConsumptionClass;

	class EveTotalConsumptionClass extends Characteristic {
		constructor() {
			super('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
			this.setProps({ format: 'float', unit: 'kWh', maxValue: 1000000000, minValue: 0, minStep: 0.001, perms: ['pr','ev'] });
			this.value = this.getDefaultValue();
		}
	}
	EveTotalConsumption = EveTotalConsumptionClass;

	class EveVoltageClass extends Characteristic {
		constructor() {
			super('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
			this.setProps({ format: 'float', unit: 'V', maxValue: 1000, minValue: 0, minStep: 0.1, perms: ['pr','ev'] });
			this.value = this.getDefaultValue();
		}
	}
	EveVoltage = EveVoltageClass;

	api.registerAccessory('3EMEnergyMeter', EnergyMeter);
	api.registerAccessory('3EMEnergyMeterEnergy', EnergyOnly);
	api.registerPlatform('3EMEnergyMeterPlatform', ThreeEmPlatform);
	try { api.registerPlatform('3EMEnergyMeter', ThreeEmPlatform); } catch (e) { }
};

function ThreeEmPlatform(log, config, api) {
	this.log = log;
	this.config = config || {};
	this.api = api;
	this.Service = api.hap.Service;
	this.Characteristic = api.hap.Characteristic;
	this.FakeGato = require('fakegato-history')(api);
	this.cachedAccessories = {};
	if (api && api.on) api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
}

ThreeEmPlatform.prototype.configureAccessory = function(accessory) {
	this.cachedAccessories[accessory.UUID] = accessory;
	if (!accessory.context) accessory.context = {};
	if (!accessory.context._fakegato && this.FakeGato) accessory.context._fakegato = new this.FakeGato('energy', accessory);
};

ThreeEmPlatform.prototype.didFinishLaunching = function() {
	const channelsToCreate = [0,1]; // Only channel 1 and 2
	const serial = this.config.serial || 'unknown-3em';
	const baseName = this.config.name || 'Shelly 3EM';
	const updateInterval = Number(this.config.update_interval || 10000);
	const opsBase = { uri: 'http://' + (this.config.ip || '127.0.0.1') + '/status/emeters?', method: 'GET', timeout: Number(this.config.timeout || 5000) };
	const self = this;

	// Remove legacy combined accessory
	try {
		const PLUGIN_NAME = require('./package.json').name || 'homebridge-3em-energy-meter';
		const PLATFORM_NAME = '3EMEnergyMeterPlatform';
		const toRemove = [];
		if (this.cachedAccessories) {
			Object.values(this.cachedAccessories).forEach(acc => {
				if (acc.displayName === baseName || acc.displayName === (baseName + ' Energy')) toRemove.push(acc);
			});
		}
		if (toRemove.length > 0 && this.api && this.api.unregisterPlatformAccessories) {
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
		}
	} catch(e) { }

	this.platformAccessories = this.platformAccessories || [];

	channelsToCreate.forEach(channelIndex => {
		const uuidSeed = serial + '-ch' + channelIndex;
		const uuid = this.api.hap.uuid.generate(uuidSeed);

		if (this.cachedAccessories && this.cachedAccessories[uuid]) {
			this.platformAccessories.push({ accessory: this.cachedAccessories[uuid], channelIndex });
			return;
		}

		const name = baseName + ' - Channel ' + (channelIndex + 1);
		const accessory = new this.api.platformAccessory(name, uuid);
		const info = accessory.getService(this.Service.AccessoryInformation) || accessory.addService(this.Service.AccessoryInformation);
		info.setCharacteristic(this.Characteristic.Manufacturer, 'Shelly')
			.setCharacteristic(this.Characteristic.Model, '3EM-channel')
			.setCharacteristic(this.Characteristic.SerialNumber, serial + '-ch' + (channelIndex + 1))
			.setCharacteristic(this.Characteristic.FirmwareRevision, version || '1.0.0');

		const light = accessory.addService(this.Service.Lightbulb, name);
		try { light.addCharacteristic(EvePowerConsumption); light.addCharacteristic(EveTotalConsumption); light.addCharacteristic(EveVoltage); } catch(e){ }

		const hist = new FakeGatoHistoryService('energy', accessory);
		if (!accessory.getService(hist.UUID)) accessory.addService(hist);
		accessory.context._fakegato = hist;

		const PLUGIN_NAME = require('./package.json').name || 'homebridge-3em-energy-meter';
		const PLATFORM_NAME = '3EMEnergyMeterPlatform';
		this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		this.platformAccessories.push({ accessory, channelIndex, lightService: light });
	});

	if (this.platformAccessories.length > 0) {
		const pollAll = function() {
			const ops = Object.assign({}, opsBase);
			if (self.config.auth) ops.auth = { user: self.config.auth.user, pass: self.config.auth.pass };
			request(ops, (err, res, body) => {
				if (err) return;
				try {
					const json = JSON.parse(body);
					if (!Array.isArray(json.emeters)) return;

					self.platformAccessories.forEach(item => {
						const idx = item.channelIndex;
						const ch = json.emeters[idx];
						if (!ch) return;
						const power = parseFloat(ch.power || 0);
						const totalWh = parseFloat(ch.total || 0);
						const total = totalWh / 1000;
						const voltage = parseFloat(ch.voltage || 0);

						const light = item.lightService;
						if (light) {
							const p = light.getCharacteristic(EvePowerConsumption);
							const t = light.getCharacteristic(EveTotalConsumption);
							const v = light.getCharacteristic(EveVoltage);
							if (p) p.updateCharacteristic(p, Math.round(power));
							if (t) t.updateCharacteristic(t, Number(total));
							if (v) v.updateCharacteristic(v, Number(voltage));
						}

						const acc = item.accessory;
						const hist = acc.context._fakegato;
						if (hist && typeof hist.addEntry === 'function') hist.addEntry({ time: Math.round(Date.now()/1000), power, energy: Math.round(totalWh) });
					});
				} catch(e){ }
			});
		};
		pollAll();
		setInterval(pollAll, updateInterval);
	}
};
