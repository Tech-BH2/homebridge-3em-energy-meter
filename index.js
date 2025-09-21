
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
// ...existing constructor code...
}

EnergyMeter.prototype.getServices = function() {
	// Create the main Outlet service
	this.service = new Service.Outlet(this.name);
	// Optionally add characteristics here (CurrentConsumption, Voltage, etc.)

	// Create the FakeGato history service
	this.historyService = new FakeGatoHistoryService('energy', this);

	return [this.service, this.historyService];
};
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
