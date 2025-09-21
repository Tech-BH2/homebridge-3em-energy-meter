
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
			this.setProps({
				format: Characteristic.Formats.UINT16,
				unit: 'W',
				maxValue: 100000,
				minValue: 0,
				minStep: 1,
				perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
			});
			this.value = this.getDefaultValue();
		}
	}
	EvePowerConsumption = EvePowerConsumptionClass;

	class EveTotalConsumptionClass extends Characteristic {
		constructor() {
			super('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
			this.setProps({
				format: Characteristic.Formats.FLOAT,
				unit: 'kWh',
				maxValue: 1000000000,
				minValue: 0,
				minStep: 0.001,
				perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
			});
			this.value = this.getDefaultValue();
		}
	}
	EveTotalConsumption = EveTotalConsumptionClass;

	class EveVoltageClass extends Characteristic {
		constructor() {
			super('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
			this.setProps({
				format: Characteristic.Formats.FLOAT,
				unit: 'V',
				maxValue: 1000,
				minValue: 0,
				minStep: 0.1,
				perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
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

	// Create the main Outlet service
	this.service = new Service.Outlet(this.name);
	// Add standard characteristics
	this.service.getCharacteristic(Characteristic.On)
		.on('get', callback => callback(null, this.powerConsumption > 0));
	this.service.getCharacteristic(Characteristic.OutletInUse)
		.on('get', callback => callback(null, this.powerConsumption > 0));

	// Optionally add custom characteristics if available in your Homebridge version
	if (Characteristic.CurrentConsumption) {
		this.service.addCharacteristic(Characteristic.CurrentConsumption);
	}
	if (Characteristic.TotalConsumption) {
		this.service.addCharacteristic(Characteristic.TotalConsumption);
	}
	if (Characteristic.Voltage) {
		this.service.addCharacteristic(Characteristic.Voltage);
	}
	if (Characteristic.Current) {
		this.service.addCharacteristic(Characteristic.Current);
	}

	// Add Eve custom characteristics so apps (Eve) recognise power/energy/voltage for history
	try {
		// Pass the characteristic constructor to addCharacteristic (HAP will create instances)
		try {
			const c1 = this.service.addCharacteristic(EvePowerConsumption);
			const c2 = this.service.addCharacteristic(EveTotalConsumption);
			const c3 = this.service.addCharacteristic(EveVoltage);
			this.evePowerChar = c1 || this.service.getCharacteristic(EvePowerConsumption);
			this.eveTotalChar = c2 || this.service.getCharacteristic(EveTotalConsumption);
			this.eveVoltageChar = c3 || this.service.getCharacteristic(EveVoltage);
			if (this.debug_log) {
				this.log('addCharacteristic returned: evePowerChar=' + !!this.evePowerChar + ', eveTotalChar=' + !!this.eveTotalChar + ', eveVoltageChar=' + !!this.eveVoltageChar);
			}
		} catch (e) {
			this.log('addCharacteristic error on main service: ' + e.message);
			this.evePowerChar = null;
			this.eveTotalChar = null;
			this.eveVoltageChar = null;
		}
		// Fallback: if addCharacteristic didn't create chars, try creating instances directly
		if (!this.evePowerChar || !this.eveTotalChar || !this.eveVoltageChar) {
			try {
				if (!this.evePowerChar) {
					const instP = new EvePowerConsumption();
					this.service.addCharacteristic(instP);
					this.evePowerChar = this.service.getCharacteristic(instP.UUID) || instP;
				}
				if (!this.eveTotalChar) {
					const instT = new EveTotalConsumption();
					this.service.addCharacteristic(instT);
					this.eveTotalChar = this.service.getCharacteristic(instT.UUID) || instT;
				}
				if (!this.eveVoltageChar) {
					const instV = new EveVoltage();
					this.service.addCharacteristic(instV);
					this.eveVoltageChar = this.service.getCharacteristic(instV.UUID) || instV;
				}
				if (this.debug_log) this.log('Fallback instance creation done: evePowerChar=' + !!this.evePowerChar + ', eveTotalChar=' + !!this.eveTotalChar + ', eveVoltageChar=' + !!this.eveVoltageChar);
			} catch (e) {
				this.log('Fallback characteristic instance creation failed: ' + e.message);
			}
		}

		// Provide simple getters for these
		if (this.evePowerChar) this.evePowerChar.on('get', callback => callback(null, Math.round(this.powerConsumption)));
		if (this.eveTotalChar) this.eveTotalChar.on('get', callback => callback(null, Number(this.totalPowerConsumption)));
		if (this.eveVoltageChar) this.eveVoltageChar.on('get', callback => callback(null, Number(this.voltage1)));

		// Debug: enumerate characteristics on the main service so we can verify Eve sees them
		if (this.debug_log) {
			try {
				this.log('Service characteristics:');
				if (this.service && Array.isArray(this.service.characteristics)) {
					this.service.characteristics.forEach(c => {
						this.log(' - ' + (c.displayName || c.UUID) + ' (' + c.UUID + ') props=' + JSON.stringify(c.props || {}));
					});
				} else {
					this.log(' - (no characteristics array available on service)');
				}
			} catch (e) {
				this.log('Failed to enumerate service characteristics: ' + e.message);
			}
		}
	} catch (e) {
		// If custom characteristics clash on some platforms, ignore but log once
		this.log('Eve characteristics not added: ' + e.message);
		this.evePowerChar = null;
		this.eveTotalChar = null;
		this.eveVoltageChar = null;
	}

	// Create the FakeGato history service
	this.historyService = new FakeGatoHistoryService('energy', this);

	// Secondary service: some clients (Eve) detect energy characteristics more reliably on common service types
	try {
		this.secondaryService = new Service.Lightbulb(this.name + ' Energy');
		// add the Eve characteristics to the secondary service as well
		try {
			const s1 = this.secondaryService.addCharacteristic(EvePowerConsumption);
			const s2 = this.secondaryService.addCharacteristic(EveTotalConsumption);
			const s3 = this.secondaryService.addCharacteristic(EveVoltage);
			this.evePowerChar2 = s1 || this.secondaryService.getCharacteristic(EvePowerConsumption);
			this.eveTotalChar2 = s2 || this.secondaryService.getCharacteristic(EveTotalConsumption);
			this.eveVoltageChar2 = s3 || this.secondaryService.getCharacteristic(EveVoltage);
			if (this.debug_log) this.log('addCharacteristic returned for secondary: evePowerChar2=' + !!this.evePowerChar2 + ', eveTotalChar2=' + !!this.eveTotalChar2 + ', eveVoltageChar2=' + !!this.eveVoltageChar2);
		} catch (e) {
			this.log('addCharacteristic error on secondary service: ' + e.message);
			this.evePowerChar2 = null;
			this.eveTotalChar2 = null;
			this.eveVoltageChar2 = null;
		}
		// Fallback for secondary service
		if (!this.evePowerChar2 || !this.eveTotalChar2 || !this.eveVoltageChar2) {
			try {
				if (!this.evePowerChar2) {
					const iP2 = new EvePowerConsumption();
					this.secondaryService.addCharacteristic(iP2);
					this.evePowerChar2 = this.secondaryService.getCharacteristic(iP2.UUID) || iP2;
				}
				if (!this.eveTotalChar2) {
					const iT2 = new EveTotalConsumption();
					this.secondaryService.addCharacteristic(iT2);
					this.eveTotalChar2 = this.secondaryService.getCharacteristic(iT2.UUID) || iT2;
				}
				if (!this.eveVoltageChar2) {
					const iV2 = new EveVoltage();
					this.secondaryService.addCharacteristic(iV2);
					this.eveVoltageChar2 = this.secondaryService.getCharacteristic(iV2.UUID) || iV2;
				}
				if (this.debug_log) this.log('Fallback instance creation for secondary done: evePowerChar2=' + !!this.evePowerChar2 + ', eveTotalChar2=' + !!this.eveTotalChar2 + ', eveVoltageChar2=' + !!this.eveVoltageChar2);
			} catch (e) {
				this.log('Fallback characteristic instance creation failed (secondary): ' + e.message);
			}
		}
		if (this.evePowerChar2) this.evePowerChar2.on('get', callback => callback(null, Math.round(this.powerConsumption)));
		if (this.eveTotalChar2) this.eveTotalChar2.on('get', callback => callback(null, Number(this.totalPowerConsumption)));
		if (this.eveVoltageChar2) this.eveVoltageChar2.on('get', callback => callback(null, Number(this.voltage1)));
		if (this.debug_log) this.log('Added secondary Energy service with Eve characteristics');
	} catch (e) {
		this.log('Failed to add secondary service: ' + e.message);
		this.secondaryService = null;
	}

	// Return services; include the secondary service if created
	// Debug: enumerate all services and their characteristics so we can see where Eve chars live
	if (this.debug_log) {
		try {
			this.log('Accessory services and characteristics:');
			const services = [informationService, this.service];
			if (this.secondaryService) services.push(this.secondaryService);
			if (this.historyService) services.push(this.historyService);
			services.forEach(svc => {
				try {
					this.log('Service: ' + (svc.displayName || svc.UUID || svc.constructor && svc.constructor.name));
					if (Array.isArray(svc.characteristics)) {
						svc.characteristics.forEach(ch => this.log('  - Char: ' + (ch.displayName || ch.UUID) + ' (' + ch.UUID + ')'));
					} else {
						this.log('  - (no characteristics array)');
					}
				} catch (e) {
					this.log('  - Failed to enumerate service chars: ' + e.message);
				}
			});
			this.log('Eve characteristic objects present: main=' + !!this.evePowerChar + ',' + !!this.eveTotalChar + ',' + !!this.eveVoltageChar + ' ; secondary=' + !!this.evePowerChar2 + ',' + !!this.eveTotalChar2 + ',' + !!this.eveVoltageChar2);
		} catch (e) {
			this.log('Failed to enumerate services: ' + e.message);
		}
	}
	if (this.secondaryService) {
		// Add a compatibility Switch service (some apps detect energy on switches)
		try {
			this.switchService = new Service.Switch(this.name + ' Energy Switch');
			this.switchService.addCharacteristic(EvePowerConsumption);
			this.switchService.addCharacteristic(EveTotalConsumption);
			this.switchService.addCharacteristic(EveVoltage);
			this.evePowerChar3 = this.switchService.getCharacteristic(EvePowerConsumption);
			this.eveTotalChar3 = this.switchService.getCharacteristic(EveTotalConsumption);
			this.eveVoltageChar3 = this.switchService.getCharacteristic(EveVoltage);
			if (this.debug_log) this.log('Added compatibility Switch service with Eve characteristics');
			return [informationService, this.service, this.secondaryService, this.switchService, this.historyService];
		} catch (e) {
			this.log('Failed to add compatibility Switch service: ' + e.message);
			return [informationService, this.service, this.secondaryService, this.historyService];
		}
	}
	// If no secondary service, still add the switch shim
	try {
		this.switchService = new Service.Switch(this.name + ' Energy Switch');
		this.switchService.addCharacteristic(EvePowerConsumption);
		this.switchService.addCharacteristic(EveTotalConsumption);
		this.switchService.addCharacteristic(EveVoltage);
		this.evePowerChar3 = this.switchService.getCharacteristic(EvePowerConsumption);
		this.eveTotalChar3 = this.switchService.getCharacteristic(EveTotalConsumption);
		this.eveVoltageChar3 = this.switchService.getCharacteristic(EveVoltage);
		if (this.debug_log) this.log('Added compatibility Switch service with Eve characteristics (no secondary)');
		return [informationService, this.service, this.switchService, this.historyService];
	} catch (e) {
		this.log('Failed to add compatibility Switch service (no secondary): ' + e.message);
		return [informationService, this.service, this.historyService];
	}
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
			// Update HomeKit characteristics
			if (this.service) {
				if (this.service.getCharacteristic(Characteristic.CurrentConsumption)) {
					this.service.getCharacteristic(Characteristic.CurrentConsumption)
						.setValue(this.powerConsumption, undefined, undefined);
				}
				if (this.service.getCharacteristic(Characteristic.TotalConsumption)) {
					this.service.getCharacteristic(Characteristic.TotalConsumption)
						.setValue(this.totalPowerConsumption, undefined, undefined);
				}
				if (this.service.getCharacteristic(Characteristic.Voltage)) {
					this.service.getCharacteristic(Characteristic.Voltage)
						.setValue(this.voltage1, undefined, undefined);
				}
				if (this.service.getCharacteristic(Characteristic.Current)) {
					this.service.getCharacteristic(Characteristic.Current)
						.setValue(this.ampere1, undefined, undefined);
				}
				this.service.getCharacteristic(Characteristic.On)
					.setValue(this.powerConsumption > 0);
				this.service.getCharacteristic(Characteristic.OutletInUse)
					.setValue(this.powerConsumption > 0);

				// Update Eve custom characteristics if present so apps like Eve treat this as an energy meter
				try {
					if (this.evePowerChar) {
						const valP = Math.round(this.powerConsumption);
						this.service.updateCharacteristic(this.evePowerChar, valP);
						this.evePowerChar.setValue(valP, undefined, (err) => {
							if (err) this.log('Error setting EvePowerConsumption: ' + err);
							if (this.debug_log) this.log('Set EvePowerConsumption=' + valP + ' (char.value=' + this.evePowerChar.value + ')');
						});
					}
					if (this.eveTotalChar) {
						const valT = Number(this.totalPowerConsumption);
						this.service.updateCharacteristic(this.eveTotalChar, valT);
						this.eveTotalChar.setValue(valT, undefined, (err) => {
							if (err) this.log('Error setting EveTotalConsumption: ' + err);
							if (this.debug_log) this.log('Set EveTotalConsumption=' + valT + ' (char.value=' + this.eveTotalChar.value + ')');
						});
					}
					if (this.eveVoltageChar) {
						const valV = Number(this.voltage1);
						this.service.updateCharacteristic(this.eveVoltageChar, valV);
						this.eveVoltageChar.setValue(valV, undefined, (err) => {
							if (err) this.log('Error setting EveVoltage: ' + err);
							if (this.debug_log) this.log('Set EveVoltage=' + valV + ' (char.value=' + this.eveVoltageChar.value + ')');
						});
					}
					// Also update secondary service characteristics (if present)
					try {
						if (this.evePowerChar2) {
							const valP2 = Math.round(this.powerConsumption);
							this.secondaryService.updateCharacteristic(this.evePowerChar2, valP2);
							this.evePowerChar2.setValue(valP2);
							if (this.debug_log) this.log('Set EvePowerConsumption (secondary)=' + valP2 + ' (char.value=' + this.evePowerChar2.value + ')');
						}
						if (this.eveTotalChar2) {
							const valT2 = Number(this.totalPowerConsumption);
							this.secondaryService.updateCharacteristic(this.eveTotalChar2, valT2);
							this.eveTotalChar2.setValue(valT2);
							if (this.debug_log) this.log('Set EveTotalConsumption (secondary)=' + valT2 + ' (char.value=' + this.eveTotalChar2.value + ')');
						}
						if (this.eveVoltageChar2) {
							const valV2 = Number(this.voltage1);
							this.secondaryService.updateCharacteristic(this.eveVoltageChar2, valV2);
							this.eveVoltageChar2.setValue(valV2);
							if (this.debug_log) this.log('Set EveVoltage (secondary)=' + valV2 + ' (char.value=' + this.eveVoltageChar2.value + ')');
						}
					} catch (e) {
						// ignore
					}
					// Also update switch shim characteristics (if present)
					try {
						if (this.evePowerChar3 && this.switchService) {
							const valP3 = Math.round(this.powerConsumption);
							this.switchService.updateCharacteristic(this.evePowerChar3, valP3);
							this.evePowerChar3.setValue(valP3);
							if (this.debug_log) this.log('Set EvePowerConsumption (switch)=' + valP3 + ' (char.value=' + this.evePowerChar3.value + ')');
						}
						if (this.eveTotalChar3 && this.switchService) {
							const valT3 = Number(this.totalPowerConsumption);
							this.switchService.updateCharacteristic(this.eveTotalChar3, valT3);
							this.eveTotalChar3.setValue(valT3);
							if (this.debug_log) this.log('Set EveTotalConsumption (switch)=' + valT3 + ' (char.value=' + this.eveTotalChar3.value + ')');
						}
						if (this.eveVoltageChar3 && this.switchService) {
							const valV3 = Number(this.voltage1);
							this.switchService.updateCharacteristic(this.eveVoltageChar3, valV3);
							this.eveVoltageChar3.setValue(valV3);
							if (this.debug_log) this.log('Set EveVoltage (switch)=' + valV3 + ' (char.value=' + this.eveVoltageChar3.value + ')');
						}
					} catch (e) {
						// ignore
					}
				} catch (e) {
					this.log('Error updating Eve characteristics: ' + e.message);
				}
			}
			// FakeGato
			if (this.historyService) {
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
				if (this.debug_log) this.log('FakeGato addEntry power=' + this.powerConsumption);
			}

			// Debug: enumerate characteristics and show their current value after updates
			if (this.debug_log && this.service && Array.isArray(this.service.characteristics)) {
				try {
					this.log('Post-update characteristic values:');
					this.service.characteristics.forEach(c => {
						// Some characteristics may not expose .value until accessed; guard against exceptions
						let v = '(no value)';
						try { v = c.value; } catch (e) { v = '(err)'; }
						this.log(' - ' + (c.displayName || c.UUID) + ': ' + v);
					});
				} catch (e) {
					this.log('Failed to enumerate characteristic values: ' + e.message);
				}
			}
		} catch (parseErr) {
			this.log('Error processing data: ' + parseErr.message);
		}
		this.waiting_response = false;
	});
};
