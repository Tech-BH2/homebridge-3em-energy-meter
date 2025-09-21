
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

function EnergyMeter(log, config, api) {
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
				// Main measurement logic (preserved from original)
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
				this.service.getCharacteristic(Characteristic.CurrentConsumption || Characteristic.ElectricCurrent)
					.setValue(this.powerConsumption, undefined, undefined);
				if (Characteristic.TotalConsumption) {
					this.service.getCharacteristic(Characteristic.TotalConsumption)
						.setValue(this.totalPowerConsumption, undefined, undefined);
				}
				if (Characteristic.Voltage) {
					this.service.getCharacteristic(Characteristic.Voltage)
						.setValue(this.voltage1, undefined, undefined);
				}
				if (Characteristic.Current) {
					this.service.getCharacteristic(Characteristic.Current)
						.setValue(this.ampere1, undefined, undefined);
				}
				this.service.getCharacteristic(Characteristic.On)
					.setValue(this.powerConsumption > 0);
				this.service.getCharacteristic(Characteristic.OutletInUse)
					.setValue(this.powerConsumption > 0);
				// FakeGato
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: this.powerConsumption });
			} catch (parseErr) {
				this.log('Error processing data: ' + parseErr.message);
			}
		this.waiting_response = false;
		});
