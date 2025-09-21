
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

	if (this.debug_log) {
		this.log('Energy services removed: accessory will only publish AccessoryInformation and FakeGato history (use the energy-only accessory for live values).');
	}

	// Return only information and history services. The separate energy-only accessory exposes Eve energy characteristics.
	return [informationService, this.historyService];
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
