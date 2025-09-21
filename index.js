
const inherits = require('util').inherits;
const request = require('request');
const version = require('./package.json').version;

let Service, Characteristic, FakeGatoHistoryService;
let EvePowerConsumption, EveTotalConsumption, EveVoltage;

module.exports = (api) => {
	Service = api.hap.Service;
	Characteristic = api.hap.Characteristic;
	FakeGatoHistoryService = require('fakegato-history')(api);

	// Define Eve custom characteristics now that Characteristic is available
	class EvePowerConsumptionClass extends Characteristic {
		constructor() {
			super('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
			// Use literal format/perms values compatible with HAP v2 to avoid undefined enum constants
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

	// Register both the main accessory and an energy-only accessory type.
	// Register both the main accessory and an energy-only accessory type (legacy accessory mode)
	api.registerAccessory('3EMEnergyMeter', EnergyMeter);
	api.registerAccessory('3EMEnergyMeterEnergy', EnergyOnly);
	// Register channel-specific energy accessory (channel index configurable via config.channelIndex) for manual accessory entries
	api.registerAccessory('3EMEnergyMeterChannel', EnergyChannel);

	// Also register a dynamic platform so the plugin can auto-create a channel accessory when configured via the UI.
	// This keeps backward compatibility while enabling the auto-create behavior (option A).
	api.registerPlatform('3EMEnergyMeterPlatform', ThreeEmPlatform);
};

// Dynamic platform implementation — creates accessories programmatically when UI option is enabled
function ThreeEmPlatform(log, config, api) {
	this.log = log;
	this.config = config || {};
	this.api = api;
	this.Service = api.hap.Service;
	this.Characteristic = api.hap.Characteristic;
	this.FakeGato = require('fakegato-history')(api);

	// cache of configured accessories restored by Homebridge
	this.cachedAccessories = {};

	if (api && api.on) {
		api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
	}
}

// Called by Homebridge to restore cached accessories
ThreeEmPlatform.prototype.configureAccessory = function(accessory) {
	this.cachedAccessories = this.cachedAccessories || {};
	this.cachedAccessories[accessory.UUID] = accessory;
	if (this.log) this.log('ThreeEmPlatform: configureAccessory restored: ' + accessory.displayName);
};

ThreeEmPlatform.prototype.didFinishLaunching = function() {
	// Only create the auto accessory if the UI option is enabled
	if (!this.config || !this.config.add_channel_accessory) {
		if (this.log) this.log('ThreeEmPlatform: auto-create disabled (add_channel_accessory=false)');
		return;
	}

	const channel = Number(this.config.channel || 2);
	const channelIndex = Math.max(1, Math.min(3, channel)) - 1; // 0-based
	const serial = this.config.serial || 'unknown-3em';
	const uuidSeed = serial + '-ch' + channelIndex;
	const uuid = this.api.hap.uuid.generate(uuidSeed);

	// If accessory already cached, skip creation
	if (this.cachedAccessories && this.cachedAccessories[uuid]) {
		this.log('ThreeEmPlatform: channel accessory already configured (UUID=' + uuid + '), skipping creation.');
		return;
	}

	const name = (this.config.name || 'Shelly 3EM') + ' - Channel ' + (channelIndex + 1);
	const accessory = new this.api.platformAccessory(name, uuid);

	// Information service
	const info = accessory.getService(this.Service.AccessoryInformation) || accessory.addService(this.Service.AccessoryInformation);
	info.setCharacteristic(this.Characteristic.Manufacturer, 'Shelly')
		.setCharacteristic(this.Characteristic.Model, '3EM-channel')
		.setCharacteristic(this.Characteristic.SerialNumber, serial + '-ch' + (channelIndex + 1))
		.setCharacteristic(this.Characteristic.FirmwareRevision, version || '1.0.0');

	// Lightbulb service used to expose Eve characteristics
	const light = accessory.addService(this.Service.Lightbulb, name);
	try {
		light.addCharacteristic(EvePowerConsumption);
		light.addCharacteristic(EveTotalConsumption);
		light.addCharacteristic(EveVoltage);
	} catch (e) {
		this.log('ThreeEmPlatform: failed to add Eve characteristics to auto accessory: ' + e.message);
	}

	// Add FakeGato history bound to the platform accessory
	try {
		const history = new this.FakeGato('energy', accessory);
		// store on context for later updates
		accessory.context._fakegato = history;
	} catch (e) {
		this.log('ThreeEmPlatform: failed to create FakeGato on auto accessory: ' + e.message);
	}

	// Register the new accessory with Homebridge
	try {
		const PLUGIN_NAME = require('./package.json').name || 'homebridge-3em-energy-meter';
		const PLATFORM_NAME = '3EMEnergyMeterPlatform';
		this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		this.log('ThreeEmPlatform: registered auto accessory: ' + name + ' (ch=' + (channelIndex + 1) + ')');
	} catch (e) {
		this.log('ThreeEmPlatform: failed to register accessory: ' + e.message);
		return;
	}

	// Polling loop to update this accessory's values (independent small poller)
	const updateInterval = Number(this.config.update_interval || 10000);
	const opsBase = { uri: 'http://' + (this.config.ip || '127.0.0.1') + '/status/emeters?', method: 'GET', timeout: Number(this.config.timeout || 5000) };
	const self = this;
	const poll = function() {
		const ops = Object.assign({}, opsBase);
		if (self.config.auth) ops.auth = { user: self.config.auth.user, pass: self.config.auth.pass };
		request(ops, (err, res, body) => {
			if (err) { self.log('ThreeEmPlatform auto accessory poll error: ' + err.message); return; }
			try {
				const json = JSON.parse(body);
				if (!Array.isArray(json.emeters) || json.emeters.length <= channelIndex) return;
				const ch = json.emeters[channelIndex];
				const power = parseFloat(ch.power || 0);
				const total = parseFloat(ch.total || 0) / 1000;
				const voltage = parseFloat(ch.voltage || 0);

				// Update characteristics
				try {
					const p = light.getCharacteristic(EvePowerConsumption);
					const t = light.getCharacteristic(EveTotalConsumption);
					const v = light.getCharacteristic(EveVoltage);
					if (p) { try { light.updateCharacteristic(p, Math.round(power)); } catch(_){}; try { p.setValue(Math.round(power)); } catch(_){} }
					if (t) { try { light.updateCharacteristic(t, Number(total)); } catch(_){}; try { t.setValue(Number(total)); } catch(_){} }
					if (v) { try { light.updateCharacteristic(v, Number(voltage)); } catch(_){}; try { v.setValue(Number(voltage)); } catch(_){} }
				} catch (e) { self.log('ThreeEmPlatform char update error: ' + e.message); }

				// FakeGato add entry if present
				try {
					const hist = accessory.context && accessory.context._fakegato;
					if (hist && typeof hist.addEntry === 'function') {
						hist.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: power });
					}
				} catch (e) { /* ignore history errors */ }
			} catch (e) {
				self.log('ThreeEmPlatform parse error: ' + e.message);
			}
		});
	};
	// immediate poll and interval
	try { poll(); } catch (e) {}
	setInterval(poll, updateInterval);
};

// Channel-specific accessory: exposes Eve energy characteristics and FakeGato history for a single emeter channel
function EnergyChannel(log, config, api) {
	this.log = log;
	this.ip = config["ip"] || "127.0.0.1";
	this.url = "http://" + this.ip + "/status/emeters?";
	this.auth = config["auth"];
	this.name = config["name"] || ("Energy ch" + (config.channelIndex || 2) + " " + this.ip);
	this.channelIndex = Number(config.channelIndex || 1); // 0-based index (0 = channel1, 1 = channel2)
	this.timeout = config["timeout"] || 5000;
	this.http_method = "GET";
	this.update_interval = Number(config["update_interval"] || 10000);
	this.debug_log = config["debug_log"] || false;

	this.powerConsumption = 0;
	this.totalPowerConsumption = 0;
	this.voltage1 = 0;

	// Services
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
		this.evePowerChar = null; this.eveTotalChar = null; this.eveVoltageChar = null;
	}

	this.historyService = new FakeGatoHistoryService('energy', this);

	setInterval(() => { this.updateState && this.updateState(); }, this.update_interval);
	try { this.updateState && this.updateState(); } catch (e) { this.log('EnergyChannel initial poll failed: ' + e.message); }
}

EnergyChannel.prototype.getServices = function() {
	return [this.informationService, this.service, this.historyService];
};

EnergyChannel.prototype.updateState = function() {
	const ops = { uri: this.url, method: this.http_method, timeout: this.timeout };
	if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };
	if (this.debug_log) this.log('EnergyChannel: requesting ' + this.url + ' (ch=' + this.channelIndex + ')');
	request(ops, (error, res, body) => {
		if (error) { this.log('EnergyChannel Bad http response: ' + error.message); return; }
		try {
			const json = JSON.parse(body);
			if (Array.isArray(json.emeters) && json.emeters.length > this.channelIndex) {
				const ch = json.emeters[this.channelIndex];
				this.powerConsumption = parseFloat(ch.power || 0);
				this.totalPowerConsumption = (parseFloat(ch.total || 0) / 1000);
				this.voltage1 = parseFloat(ch.voltage || 0);
			}
			if (this.debug_log) this.log('EnergyChannel successful: ch=' + this.channelIndex + ' power=' + this.powerConsumption + ' total=' + this.totalPowerConsumption + ' V=' + this.voltage1);

			if (this.service) {
				try {
					const p = this.service.getCharacteristic(EvePowerConsumption);
					const t = this.service.getCharacteristic(EveTotalConsumption);
					const v = this.service.getCharacteristic(EveVoltage);
					if (p) try { this.service.updateCharacteristic(p, Math.round(this.powerConsumption)); p.setValue(Math.round(this.powerConsumption)); } catch(e){}
					if (t) try { this.service.updateCharacteristic(t, Number(this.totalPowerConsumption)); t.setValue(Number(this.totalPowerConsumption)); } catch(e){}
					if (v) try { this.service.updateCharacteristic(v, Number(this.voltage1)); v.setValue(Number(this.voltage1)); } catch(e){}
				} catch (e) { this.log('EnergyChannel char update error: ' + e.message); }
			}

			if (this.historyService) {
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
				if (this.debug_log) this.log('EnergyChannel FakeGato addEntry power=' + this.powerConsumption);
			}
		} catch (e) {
			this.log('EnergyChannel parse error: ' + e.message);
		}
	});
};

// Energy-only accessory: exposes Eve energy characteristics and FakeGato history only.
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

	// Create services
	this.informationService = new Service.AccessoryInformation();
	this.informationService
		.setCharacteristic(Characteristic.Manufacturer, 'Shelly')
		.setCharacteristic(Characteristic.Model, '3EM-energy-only')
		.setCharacteristic(Characteristic.SerialNumber, config.serial || 'unknown')
		.setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

	this.service = new Service.Lightbulb(this.name);

	// Add Eve custom characteristics
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
		this.evePowerChar = null; this.eveTotalChar = null; this.eveVoltageChar = null;
	}

	this.historyService = new FakeGatoHistoryService('energy', this);

	// Polling
	setInterval(() => { this.updateState && this.updateState(); }, this.update_interval);
	try { this.updateState && this.updateState(); } catch (e) { this.log('EnergyOnly initial poll failed: ' + e.message); }
}

EnergyOnly.prototype.getServices = function() {
	return [this.informationService, this.service, this.historyService];
};

EnergyOnly.prototype.updateState = function() {
	const ops = { uri: this.url, method: this.http_method, timeout: this.timeout };
	if (this.auth) ops.auth = { user: this.auth.user, pass: this.auth.pass };
	if (this.debug_log) this.log('EnergyOnly: requesting ' + this.url);
	request(ops, (error, res, body) => {
		if (error) { this.log('EnergyOnly Bad http response: ' + error.message); return; }
		try {
			const json = JSON.parse(body);
			// Aggregate emeters
			this.powerConsumption = 0;
			this.totalPowerConsumption = 0;
			this.voltage1 = 0;
			if (Array.isArray(json.emeters) && json.emeters.length > 0) {
				for (let i = 0; i < json.emeters.length; i++) {
					this.powerConsumption += parseFloat(json.emeters[i].power || 0);
					this.totalPowerConsumption += parseFloat(json.emeters[i].total || 0);
					this.voltage1 += parseFloat(json.emeters[i].voltage || 0);
				}
				this.totalPowerConsumption = this.totalPowerConsumption / 1000; // to kWh
				this.voltage1 = this.voltage1 / json.emeters.length;
			}

			if (this.debug_log) this.log('EnergyOnly successful: power=' + this.powerConsumption + ' total=' + this.totalPowerConsumption + ' V=' + this.voltage1);

			if (this.service) {
				try {
					if (this.evePowerChar) { this.service.updateCharacteristic(this.evePowerChar, Math.round(this.powerConsumption)); this.evePowerChar.setValue(Math.round(this.powerConsumption)); }
					if (this.eveTotalChar) { this.service.updateCharacteristic(this.eveTotalChar, Number(this.totalPowerConsumption)); this.eveTotalChar.setValue(Number(this.totalPowerConsumption)); }
					if (this.eveVoltageChar) { this.service.updateCharacteristic(this.eveVoltageChar, Number(this.voltage1)); this.eveVoltageChar.setValue(Number(this.voltage1)); }
				} catch (e) { this.log('EnergyOnly char update error: ' + e.message); }
			}

			if (this.historyService) {
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
				if (this.debug_log) this.log('EnergyOnly FakeGato addEntry power=' + this.powerConsumption);
			}
		} catch (e) {
			this.log('EnergyOnly parse error: ' + e.message);
		}
	});
};

function EnergyMeter(log, config, api) {
	// constructor continues below
	this.log = log;
	this.ip = config["ip"] || "127.0.0.1";
	this.url = "http://" + this.ip + "/status/emeters?";
	this.auth = config["auth"];
	this.name = config["name"];
	this.displayName = config["name"];
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

	// Set up polling interval for state updates
	setInterval(() => {
		this.updateState && this.updateState();
	}, this.update_interval);

	// Do one immediate poll so values appear quickly after startup
	try {
		this.updateState && this.updateState();
	} catch (e) {
		this.log('Initial updateState failed: ' + e.message);
	}
}

EnergyMeter.prototype.getServices = function() {
	// Accessory information
	const informationService = new Service.AccessoryInformation();
	informationService
		.setCharacteristic(Characteristic.Manufacturer, 'Shelly')
		.setCharacteristic(Characteristic.Model, '3EM')
		.setCharacteristic(Characteristic.SerialNumber, this.serial || 'unknown')
		.setCharacteristic(Characteristic.FirmwareRevision, version || '1.0.0');

	// Create the FakeGato history service (keep history available)
	this.historyService = new FakeGatoHistoryService('energy', this);

	// Provide a single visible Lightbulb service that exposes Eve energy characteristics so clients (Eve) can discover energy data.
	try {
		this.energyService = new Service.Lightbulb(this.name + ' Energy');
		// Add Eve custom characteristics to the energy service
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
			this.evePowerChar = null; this.eveTotalChar = null; this.eveVoltageChar = null;
		}
		// Fallback: direct instance creation
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
		// Provide getters so HomeKit can read values
		if (this.evePowerChar) this.evePowerChar.on('get', callback => callback(null, Math.round(this.powerConsumption)));
		if (this.eveTotalChar) this.eveTotalChar.on('get', callback => callback(null, Number(this.totalPowerConsumption)));
		if (this.eveVoltageChar) this.eveVoltageChar.on('get', callback => callback(null, Number(this.voltage1)));
	} catch (e) {
		this.log('Failed to create energy service: ' + e.message);
		this.energyService = null;
	}

	if (this.debug_log) {
		this.log('Energy service present: ' + !!this.energyService + ' ; history present: ' + !!this.historyService);
	}

	// Return information, energy service (if created), and history
	const services = [informationService];
	if (this.energyService) services.push(this.energyService);
	if (this.historyService) services.push(this.historyService);
	return services;
};

EnergyMeter.prototype.updateState = function() {
	// Poll Shelly 3EM for data and update HomeKit characteristics
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
		ops.auth = {
			user: this.auth.user,
			pass: this.auth.pass
		};
	}
	request(ops, (error, res, body) => {
		if (error) {
			this.log('Bad http response! (' + ops.uri + '): ' + error.message);
			this.waiting_response = false;
			return;
		}

				// Debug: log HTTP response status and a truncated body to help map JSON fields
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
			// Power factor
			if ((this.use_pf) && (this.use_em == false)) {
				this.pf0 = parseFloat(json.emeters[0].pf);
				this.pf1 = parseFloat(json.emeters[1].pf);
				this.pf2 = parseFloat(json.emeters[2].pf);
			} else {
				this.pf0 = 1;
				this.pf1 = 1;
				this.pf2 = 1;
			}
			// Main measurement logic
			if (this.use_em) {
				if (this.use_em_mode == 0) {
					if (this.negative_handling_mode == 0) {
						this.powerConsumption = (parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power));
						this.totalPowerConsumption = ((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total)) / 1000);
						this.voltage1 = (((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage)) / 2));
						this.ampere1 = ((this.powerConsumption / this.voltage1));
						if (this.powerConsumption < 0) { this.powerConsumption = 0; }
						if (this.totalPowerConsumption < 0) { this.totalPowerConsumption = 0; }
						if (this.voltage1 < 0) { this.voltage1 = 0; }
						if (this.ampere1 < 0) { this.ampere1 = 0; }
					} else if (this.negative_handling_mode == 1) {
						this.powerConsumption = Math.abs(parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power));
						this.totalPowerConsumption = Math.abs((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total)) / 1000);
						this.voltage1 = Math.abs(((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage)) / 2));
						this.ampere1 = Math.abs((this.powerConsumption / this.voltage1));
					}
				} else if (this.use_em_mode == 1) {
					if (this.negative_handling_mode == 0) {
						this.powerConsumption = (parseFloat(json.emeters[0].power));
						this.totalPowerConsumption = (parseFloat(json.emeters[0].total) / 1000);
						this.voltage1 = (parseFloat(json.emeters[0].voltage));
						this.ampere1 = ((this.powerConsumption / this.voltage1));
						if (this.powerConsumption < 0) { this.powerConsumption = 0; }
						if (this.totalPowerConsumption < 0) { this.totalPowerConsumption = 0; }
						if (this.voltage1 < 0) { this.voltage1 = 0; }
						if (this.ampere1 < 0) { this.ampere1 = 0; }
					} else if (this.negative_handling_mode == 1) {
						this.powerConsumption = Math.abs(parseFloat(json.emeters[0].power));
						this.totalPowerConsumption = Math.abs(parseFloat(json.emeters[0].total) / 1000);
						this.voltage1 = Math.abs(parseFloat(json.emeters[0].voltage));
						this.ampere1 = Math.abs((this.powerConsumption / this.voltage1));
					}
				} else if (this.use_em_mode == 2) {
					if (this.negative_handling_mode == 0) {
						this.powerConsumption = (parseFloat(json.emeters[1].power));
						this.totalPowerConsumption = (parseFloat(json.emeters[1].total) / 1000);
						this.voltage1 = (parseFloat(json.emeters[1].voltage));
						this.ampere1 = ((this.powerConsumption / this.voltage1));
						if (this.powerConsumption < 0) { this.powerConsumption = 0; }
						if (this.totalPowerConsumption < 0) { this.totalPowerConsumption = 0; }
						if (this.voltage1 < 0) { this.voltage1 = 0; }
						if (this.ampere1 < 0) { this.ampere1 = 0; }
					} else if (this.negative_handling_mode == 1) {
						this.powerConsumption = Math.abs(parseFloat(json.emeters[1].power));
						this.totalPowerConsumption = Math.abs(parseFloat(json.emeters[1].total) / 1000);
						this.voltage1 = Math.abs(parseFloat(json.emeters[1].voltage));
						this.ampere1 = Math.abs((this.powerConsumption / this.voltage1));
					}
				}
			} else {
				if (this.negative_handling_mode == 0) {
					this.powerConsumption = (parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power) + parseFloat(json.emeters[2].power));
					this.totalPowerConsumption = ((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total) + parseFloat(json.emeters[2].total)) / 1000);
					this.voltage1 = (((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
					this.ampere1 = (((parseFloat(json.emeters[0].current) * this.pf0)
						+ (parseFloat(json.emeters[1].current) * this.pf1)
						+ (parseFloat(json.emeters[2].current) * this.pf2)));
					if (this.powerConsumption < 0) { this.powerConsumption = 0; }
					if (this.totalPowerConsumption < 0) { this.totalPowerConsumption = 0; }
					if (this.voltage1 < 0) { this.voltage1 = 0; }
					if (this.ampere1 < 0) { this.ampere1 = 0; }
				} else if (this.negative_handling_mode == 1) {
					this.powerConsumption = Math.abs(parseFloat(json.emeters[0].power) + parseFloat(json.emeters[1].power) + parseFloat(json.emeters[2].power));
					this.totalPowerConsumption = Math.abs((parseFloat(json.emeters[0].total) + parseFloat(json.emeters[1].total) + parseFloat(json.emeters[2].total)) / 1000);
					this.voltage1 = Math.abs(((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
					this.ampere1 = Math.abs(((parseFloat(json.emeters[0].current) * this.pf0)
						+ (parseFloat(json.emeters[1].current) * this.pf1)
						+ (parseFloat(json.emeters[2].current) * this.pf2)));
				}
			}
			if (this.debug_log) {
				this.log('Successful http response. [ voltage: ' + this.voltage1.toFixed(0) + 'V, current: ' + this.ampere1.toFixed(1) + 'A, consumption: ' + this.powerConsumption.toFixed(0) + 'W, total consumption: ' + this.totalPowerConsumption.toFixed(2) + 'kWh ]');
			}
			// We intentionally removed the Outlet/Lightbulb/Switch services from this accessory.
			// The dedicated energy-only accessory publishes Eve characteristics and receives updates independently.
			// Here we only write to FakeGato and log the latest values.
			// FakeGato
			if (this.historyService) {
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
				if (this.debug_log) this.log('FakeGato addEntry power=' + this.powerConsumption);
			}

			// Update energy service Eve characteristics safely: retrieve actual characteristic instances from the service
			try {
				if (this.energyService) {
					// getCharacteristic accepts a constructor or UUID in HAP; try both
					const chP = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EvePowerConsumption)) || null;
					const chT = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EveTotalConsumption)) || null;
					const chV = (this.energyService.getCharacteristic && this.energyService.getCharacteristic(EveVoltage)) || null;
					if (chP) {
						const valP = Math.round(this.powerConsumption);
						try { this.energyService.updateCharacteristic(chP, valP); } catch(_){}
						try { chP.setValue(valP); } catch (e) { if (this.debug_log) this.log('chP.setValue error: ' + e.message); }
					}
					if (chT) {
						const valT = Number(this.totalPowerConsumption);
						try { this.energyService.updateCharacteristic(chT, valT); } catch(_){}
						try { chT.setValue(valT); } catch (e) { if (this.debug_log) this.log('chT.setValue error: ' + e.message); }
					}
					if (chV) {
						const valV = Number(this.voltage1);
						try { this.energyService.updateCharacteristic(chV, valV); } catch(_){}
						try { chV.setValue(valV); } catch (e) { if (this.debug_log) this.log('chV.setValue error: ' + e.message); }
					}
				}
			} catch (e) {
				this.log('Error updating energy service characteristics: ' + e.message);
			}

			// Debug: show computed values only
			if (this.debug_log) {
				this.log('Post-update values: power=' + Math.round(this.powerConsumption) + 'W, total=' + Number(this.totalPowerConsumption).toFixed(2) + 'kWh, V=' + Number(this.voltage1).toFixed(1));
			}
		} catch (parseErr) {
			this.log('Error processing data: ' + parseErr.message);
		}
		this.waiting_response = false;
	});
};
