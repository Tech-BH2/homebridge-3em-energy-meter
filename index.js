const http = require("http");
let Service, Characteristic, UUIDGen, FakeGatoHistoryService;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  FakeGatoHistoryService = require("fakegato-history")(api);

  class EnergyMeterPlatform {
    constructor(log, config, api) {
      this.log = log;
      this.api = api;
      this.devices = config.devices || [];
      this.accessories = [];
    }

    configureAccessory(accessory) {
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

    didFinishLaunching() {
      this.discoverDevices();
    }
  }

  class EnergyMeterAccessory {
    constructor(log, accessory, device, api) {
      this.log = log;
      this.accessory = accessory;
      this.device = device;
      this.api = api;

      this.accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Shelly")
        .setCharacteristic(Characteristic.Model, "EM")
        .setCharacteristic(Characteristic.SerialNumber, device.id);

      const outletService = new Service.Outlet(device.name);
      this.accessory.addService(outletService);

      const currentConsumption = new Characteristic(
        'Current Consumption',
        'E863F10D-079E-48FF-8F27-9C2605A29F52'
      );
      currentConsumption.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
      outletService.addCharacteristic(currentConsumption);

      // Initialize FakeGato history
      this.historyService = new FakeGatoHistoryService("energy", this.accessory, { storage: 'fs' });

      // Poll real Shelly EM values
      this.pollShellyEM(currentConsumption);
      setInterval(() => this.pollShellyEM(currentConsumption), 10000); // every 10 seconds
    }

    pollShellyEM(characteristic) {
      const options = {
        hostname: this.device.host,
        port: 80,
        path: "/status",
        method: "GET",
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            // Shelly EM returns emeters[0].power for channel 0
            const power = json.emeters[0].power;
            characteristic.updateValue(power);
            this.historyService.addEntry({ time: Math.floor(Date.now()/1000), power: power });
          } catch (e) {
            this.log.error(`Failed to parse Shelly EM response: ${e}`);
          }
        });
      });

      req.on("error", (err) => {
        this.log.error(`Error polling Shelly EM at ${this.device.host}: ${err}`);
      });

      req.end();
    }
  }

  api.registerPlatform("homebridge-3em-energy-meter", "3EMEnergyMeter", EnergyMeterPlatform, true);
};