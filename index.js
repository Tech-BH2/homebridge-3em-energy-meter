"use strict";

const request = require("http");
const FakeGatoHistoryService = require("fakegato-history");

let Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Eve custom characteristics
  class EveCurrentConsumption extends Characteristic {
    constructor() {
      super("Current Consumption", "E863F10D-079E-48FF-8F27-9C2605A29F52");
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: "W",
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class EveTotalConsumption extends Characteristic {
    constructor() {
      super("Total Consumption", "E863F10E-079E-48FF-8F27-9C2605A29F52");
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: "kWh",
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class EveVoltage extends Characteristic {
    constructor() {
      super("Voltage", "E863F10C-079E-48FF-8F27-9C2605A29F52");
      this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: "V",
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  // Platform
  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.config = config || {};
      this.api = api;

      this.devices = this.config.devices || [];
      this.accessories = [];

      if (api) {
        api.on("didFinishLaunching", () => {
          this.discoverDevices();
        });
      }
    }

    configureAccessory(accessory) {
      this.accessories = this.accessories || [];
      this.accessories.push(accessory);
    }

    discoverDevices() {
      this.devices.forEach((device) => {
        if (!device.host) {
          this.log.error(`Device ${device.name || "Unnamed"} missing host`);
          return;
        }

        const uuid = UUIDGen.generate(device.id || device.name);
        let accessory = this.accessories.find((acc) => acc.UUID === uuid);

        if (!accessory) {
          this.log(`Creating new accessory for ${device.name}`);
          accessory = new this.api.platformAccessory(device.name, uuid);

          new EnergyMeterAccessory(this.log, accessory, device);

          this.api.registerPlatformAccessories(
            "homebridge-3em-energy-meter",
            "3EMEnergyMeter",
            [accessory]
          );
          this.accessories.push(accessory);
        } else {
          this.log(`Restoring accessory for ${device.name}`);
          new EnergyMeterAccessory(this.log, accessory, device);
        }
      });
    }
  }

  class EnergyMeterAccessory {
    constructor(log, accessory, device) {
      this.log = log;
      this.accessory = accessory;
      this.device = device;

      this.service =
        accessory.getService(Service.Outlet) ||
        accessory.addService(Service.Outlet, device.name);

      // Add Eve custom characteristics
      this.currentConsumption = this.service.addCharacteristic(
        new EveCurrentConsumption()
      );
      this.totalConsumption = this.service.addCharacteristic(
        new EveTotalConsumption()
      );
      this.voltage = this.service.addCharacteristic(new EveVoltage());

      // FakeGato
      this.historyService = new FakeGatoHistoryService("energy", accessory, {
        storage: "fs",
        disableTimer: false,
      });

      // Initial update
      this.updateValues();
      setInterval(() => this.updateValues(), 5000);
    }

    updateValues() {
      this.getCurrentPower((err, current) => {
        if (!err && current != null) {
          this.currentConsumption.updateValue(current);
          this.historyService.addEntry({
            time: Math.floor(Date.now() / 1000),
            power: current,
            voltage: null,
            current: null,
          });
        }
      });

      this.getTotalEnergy((err, total) => {
        if (!err && total != null) {
          this.totalConsumption.updateValue(total);
        }
      });

      this.getVoltage((err, voltage) => {
        if (!err && voltage != null) {
          this.voltage.updateValue(voltage);
        }
      });
    }

    // Shelly EM HTTP API methods
    getCurrentPower(callback) {
      request.get(
        {
          host: this.device.host,
          path: "/status/em",
          timeout: 2000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const power = json.emeters[0].power; // single phase
              callback(null, power);
            } catch (e) {
              callback(e);
            }
          });
        }
      ).on("error", (err) => callback(err));
    }

    getTotalEnergy(callback) {
      request.get(
        {
          host: this.device.host,
          path: "/status/em",
          timeout: 2000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const total = json.emeters[0].total / 1000; // Wh → kWh
              callback(null, total);
            } catch (e) {
              callback(e);
            }
          });
        }
      ).on("error", (err) => callback(err));
    }

    getVoltage(callback) {
      request.get(
        {
          host: this.device.host,
          path: "/status/em",
          timeout: 2000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const voltage = json.emeters[0].voltage;
              callback(null, voltage);
            } catch (e) {
              callback(e);
            }
          });
        }
      ).on("error", (err) => callback(err));
    }
  }

  // Register platform
  api.registerPlatform(
    "homebridge-3em-energy-meter",
    "3EMEnergyMeter",
    EnergyMeterPlatform,
    true
  );
};