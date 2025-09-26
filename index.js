const http = require("http");
const FakeGatoHistoryService = require("fakegato-history");

let Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  api.registerPlatform(
    "homebridge-3em-energy-meter",
    "3EMEnergyMeter",
    EnergyMeterPlatform,
    true
  );
};

class EnergyMeterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.devices = this.config.devices || [];

    api.on("didFinishLaunching", () => {
      this.log("3EMEnergyMeter: didFinishLaunching — creating/restoring devices");
      this.discoverDevices();
    });
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

        new EnergyMeterAccessory(this.log, accessory, device, this.api);

        this.api.registerPlatformAccessories(
          "homebridge-3em-energy-meter",
          "3EMEnergyMeter",
          [accessory]
        );
        this.accessories.push(accessory);
      } else {
        this.log(`Restoring accessory for ${device.name}`);
        new EnergyMeterAccessory(this.log, accessory, device, this.api);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class EnergyMeterAccessory {
  constructor(log, accessory, device, api) {
    this.log = log;
    this.accessory = accessory;
    this.device = device;
    this.api = api;

    this.service =
      this.accessory.getService(Service.Outlet) ||
      this.accessory.addService(Service.Outlet, device.name);

    // FakeGato history
    this.loggingService = new FakeGatoHistoryService("energy", this.accessory, {
      storage: "fs",
    });

    // Eve characteristics
    this.currentConsumption = this.service.addCharacteristic(
      class EveCurrentConsumption extends Characteristic {
        constructor() {
          super("Current Consumption", "E863F10D-079E-48FF-8F27-9C2605A29F52");
          this.setProps({
            format: api.hap.Formats.FLOAT,
            unit: "W",
            perms: [api.hap.Perms.READ, api.hap.Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
      }
    );

    this.totalConsumption = this.service.addCharacteristic(
      class EveTotalConsumption extends Characteristic {
        constructor() {
          super("Total Consumption", "E863F10C-079E-48FF-8F27-9C2605A29F52");
          this.setProps({
            format: api.hap.Formats.FLOAT,
            unit: "kWh",
            perms: [api.hap.Perms.READ, api.hap.Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
      }
    );

    this.voltage = this.service.addCharacteristic(
      class EveVoltage extends Characteristic {
        constructor() {
          super("Voltage", "E863F10A-079E-48FF-8F27-9C2605A29F52");
          this.setProps({
            format: api.hap.Formats.FLOAT,
            unit: "V",
            perms: [api.hap.Perms.READ, api.hap.Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
      }
    );

    this.updateValues();
    setInterval(() => this.updateValues(), 30000);
  }

  updateValues() {
    this.getShellyData()
      .then((data) => {
        if (!data || !data.emeters) return;

        const emeter = data.emeters[0];
        const power = emeter.power || 0;
        const total = (emeter.total || 0) / 1000; // Wh → kWh
        const voltage = emeter.voltage || 0;

        this.currentConsumption.updateValue(power);
        this.totalConsumption.updateValue(total);
        this.voltage.updateValue(voltage);

        this.loggingService.addEntry({
          time: Math.round(new Date().valueOf() / 1000),
          power: power,
        });

        this.log(
          `Updated ${this.device.name}: ${power} W, ${total} kWh, ${voltage} V`
        );
      })
      .catch((err) => {
        this.log.error(`Error updating ${this.device.name}: ${err.message}`);
      });
  }

  getShellyData() {
    return new Promise((resolve, reject) => {
      const url = `http://${this.device.host}/emeter/0`;
      http
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", (err) => reject(err));
    });
  }
}