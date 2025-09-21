
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
	api.registerAccessory('3EMEnergyMeter', EnergyMeter);
	api.registerAccessory('3EMEnergyMeterEnergy', EnergyOnly);
	// Register channel-specific energy accessory (channel index configurable via config.channelIndex)
	api.registerAccessory('3EMEnergyMeterChannel', EnergyChannel);
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
