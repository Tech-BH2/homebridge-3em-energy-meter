
const inherits = require('util').inherits;
const request = require('request');
const version = require('./package.json').version;

let Service, Characteristic, FakeGatoHistoryService;


module.exports = (api) => {
	Service = api.hap.Service;
	Characteristic = api.hap.Characteristic;
	FakeGatoHistoryService = require('fakegato-history')(api);
	api.registerAccessory('3EMEnergyMeter', EnergyMeter);
};

// Eve / Elgato custom characteristics used by many energy plugins and the Eve app
// These are optional but help apps recognise power/energy/voltage values for history display
var EvePowerConsumption = function () {
	Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
	this.setProps({
		format: Characteristic.Formats.UINT16,
		unit: 'W',
		maxValue: 100000,
		minValue: 0,
		minStep: 1,
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
};
inherits(EvePowerConsumption, Characteristic);

var EveTotalConsumption = function () {
	Characteristic.call(this, 'Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
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
inherits(EveTotalConsumption, Characteristic);

var EveVoltage = function () {
	Characteristic.call(this, 'Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
	this.setProps({
		format: Characteristic.Formats.FLOAT,
		unit: 'V',
		maxValue: 1000,
		minValue: 0,
		minStep: 0.1,
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
};
inherits(EveVoltage, Characteristic);

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
		this.service.addCharacteristic(new EvePowerConsumption());
		this.service.addCharacteristic(new EveTotalConsumption());
		this.service.addCharacteristic(new EveVoltage());

		// Provide simple getters for these
		this.service.getCharacteristic(EvePowerConsumption)
			.on('get', callback => callback(null, Math.round(this.powerConsumption)));
		this.service.getCharacteristic(EveTotalConsumption)
			.on('get', callback => callback(null, Number(this.totalPowerConsumption)));
		this.service.getCharacteristic(EveVoltage)
			.on('get', callback => callback(null, Number(this.voltage1)));
	} catch (e) {
		// If custom characteristics clash on some platforms, ignore silently
		this.log('Eve characteristics not added: ' + e.message);
	}

	// Create the FakeGato history service
	this.historyService = new FakeGatoHistoryService('energy', this);

	return [informationService, this.service, this.historyService];
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
					if (this.service.getCharacteristic(EvePowerConsumption)) {
						this.service.getCharacteristic(EvePowerConsumption)
							.setValue(Math.round(this.powerConsumption));
					}
					if (this.service.getCharacteristic(EveTotalConsumption)) {
						this.service.getCharacteristic(EveTotalConsumption)
							.setValue(Number(this.totalPowerConsumption));
					}
					if (this.service.getCharacteristic(EveVoltage)) {
						this.service.getCharacteristic(EveVoltage)
							.setValue(Number(this.voltage1));
					}
				} catch (e) {
					// ignore if custom characteristics are not available
				}
			}
			// FakeGato
			if (this.historyService) {
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
			}
		} catch (parseErr) {
			this.log('Error processing data: ' + parseErr.message);
		}
		this.waiting_response = false;
	});
};
