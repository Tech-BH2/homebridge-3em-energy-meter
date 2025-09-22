/**
 * A Homebridge platform plugin for the Shelly 3EM energy meter.
 * This plugin is designed to run as a child bridge and supports the Eve app's
 * power consumption characteristics.
 *
 * It has been refactored to use a modern Homebridge platform structure,
 * replaces the deprecated `request` library with `axios`, and includes
 * error handling and logging.
 *
 * This version also supports the Homebridge UI configuration schema.
 */

// Import Homebridge API and services
const axios = require('axios');

// Custom characteristics for Eve app power consumption and total energy
const CUSTOM_EVE_CHARACTERISTICS = {
    CurrentConsumption: 'E863F10D-079E-48FF-8F27-9C26071B8B0F',
    TotalConsumption: 'E863F10C-079E-48FF-8F27-9C26071B8B0F',
};

// Global variables to store Homebridge API and platform accessory class
let Service, Characteristic, PlatformAccessory;

// The main plugin function that Homebridge calls to register the platform
module.exports = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    PlatformAccessory = api.platformAccessory;
    api.registerPlatform('3em-energy-meter', '3emEnergyMeter', EM3EnergyMeterPlatform);
};

// The platform class which manages the accessories
class EM3EnergyMeterPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = [];

        // Check for required configuration
        if (!config || !config.devices || !Array.isArray(config.devices)) {
            this.log.error('Missing or invalid "devices" configuration. Please check your config.json.');
            return;
        }

        // Homebridge API has finished loading and is ready to restore accessories
        this.api.on('didFinishLaunching', () => {
            this.log.debug('didFinishLaunching event received.');
            this.discoverDevices();
        });
    }

    /**
     * This function is called by Homebridge to restore cached accessories.
     * We need to store them so we can update them later.
     * @param {PlatformAccessory} accessory The accessory being restored.
     */
    configureAccessory(accessory) {
        this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
        this.accessories.push(accessory);
    }

    /**
     * Main function to discover and register devices based on the configuration.
     */
    async discoverDevices() {
        this.log.info('Discovering 3EM energy meters...');
        const devices = this.config.devices;
        
        for (const device of devices) {
            const { name, ip } = device;

            if (!name || !ip) {
                this.log.warn('Device configuration is missing "name" or "ip". Skipping this device.');
                continue;
            }

            // Generate a unique UUID for each accessory
            const uuid = this.api.hap.uuid.generate(ip);
            let accessory = this.accessories.find(acc => acc.UUID === uuid);

            try {
                // Fetch initial data to check if the device is reachable
                const response = await axios.get(`http://${ip}/status`, { timeout: 5000 });
                const status = response.data;
                this.log.debug(`Successfully connected to device at ${ip}`);

                if (accessory) {
                    this.log.info(`Restoring existing accessory: ${name}`);
                } else {
                    // Create a new accessory if it's the first time
                    this.log.info(`Adding new accessory: ${name}`);
                    accessory = new PlatformAccessory(name, uuid);
                    accessory.context.device = device;
                    this.api.registerPlatformAccessories('homebridge-3em-energy-meter', '3emEnergyMeter', [accessory]);
                    this.accessories.push(accessory);
                }

                // Create a new instance of the accessory handler
                new EnergyMeterAccessory(this.log, this.api, accessory, this.config.updateInterval);

            } catch (error) {
                this.log.error(`Could not connect to device at IP ${ip}. Please check the IP address and power status.`);
                this.log.error(error.message);
            }
        }
    }
}

// The class that handles the accessory's services and characteristics
class EnergyMeterAccessory {
    constructor(log, api, accessory, updateInterval = 5000) {
        this.log = log;
        this.api = api;
        this.accessory = accessory;
        this.device = accessory.context.device;
        this.updateInterval = updateInterval;

        // Set the accessory information
        this.accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Shelly')
            .setCharacteristic(Characteristic.Model, '3EM Energy Meter')
            .setCharacteristic(Characteristic.SerialNumber, this.device.ip);

        // Add the custom `CurrentConsumption` and `TotalConsumption` characteristics
        Characteristic.CurrentConsumption = this.createCharacteristic(CUSTOM_EVE_CHARACTERISTICS.CurrentConsumption, 'Current Consumption', 'power', 'W', -1);
        Characteristic.TotalConsumption = this.createCharacteristic(CUSTOM_EVE_CHARACTERISTICS.TotalConsumption, 'Total Consumption', 'energy', 'kWh', 0);
        
        // Add a service for each phase. This allows for individual power readings.
        const phases = ['A', 'B', 'C'];
        
        phases.forEach((phase, index) => {
            const serviceName = `Phase ${phase} Power`;
            let service = this.accessory.getService(serviceName);
            if (!service) {
                // Use a custom service to show as a unique accessory in Eve
                service = new Service(serviceName, `3em-energy-meter-service-${index}`);
                this.accessory.addService(service);
            }

            // Create the custom characteristics for this phase
            const currentConsumptionChar = service.getCharacteristic(Characteristic.CurrentConsumption);
            const totalConsumptionChar = service.getCharacteristic(Characteristic.TotalConsumption);
            
            // Set up get handler to report power and total energy
            currentConsumptionChar.on('get', this.handleCharacteristicGet.bind(this, 'power', `total_power`, 'W'));
            totalConsumptionChar.on('get', this.handleCharacteristicGet.bind(this, 'energy', `total_power`, 'W'));
        });

        // Start the polling interval to update the characteristics
        this.pollStatus();
    }

    /**
     * Creates and registers a custom characteristic.
     * @param {string} uuid The UUID of the characteristic.
     * @param {string} displayName The display name for the characteristic.
     * @param {string} format The format of the characteristic (e.g., 'float').
     * @param {string} unit The unit (e.g., 'W').
     * @param {number} minValue The minimum value.
     */
    createCharacteristic(uuid, displayName, format, unit, minValue) {
        return class extends Characteristic {
            constructor() {
                super(displayName, uuid);
                this.setProps({
                    format: format === 'power' ? Characteristic.Formats.FLOAT : Characteristic.Formats.UINT32,
                    unit: unit,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                    minValue: minValue,
                });
                this.value = this.getDefaultValue();
            }
        };
    }

    /**
     * Handles the 'get' event for a characteristic, fetching and returning data.
     * @param {string} dataType The type of data to fetch ('power' or 'energy').
     * @param {string} key The key to look for in the API response.
     * @param {string} unit The unit of the data.
     * @param {function} callback The Homebridge callback function.
     */
    async handleCharacteristicGet(dataType, key, unit, callback) {
        this.log.debug(`Getting ${dataType} for ${this.accessory.displayName}`);
        try {
            const response = await axios.get(`http://${this.device.ip}/status`, { timeout: 5000 });
            const status = response.data;
            let value;
            
            // The Shelly 3EM API provides total power and total energy.
            if (dataType === 'power') {
                value = status.total_power;
            } else if (dataType === 'energy') {
                value = status.total_energy / 1000; // Convert Wh to kWh
            } else {
                return callback(new Error('Invalid data type requested'));
            }
            
            this.log.info(`Fetched ${dataType}: ${value} ${unit}`);
            callback(null, value);

        } catch (error) {
            this.log.error(`Error fetching data for ${this.accessory.displayName}: ${error.message}`);
            callback(error, null);
        }
    }

    /**
     * Periodically polls the device for updates.
     */
    async pollStatus() {
        try {
            const response = await axios.get(`http://${this.device.ip}/status`, { timeout: 5000 });
            const status = response.data;
            const currentPower = status.total_power;
            const totalEnergy = status.total_energy / 1000; // Convert Wh to kWh

            // Update characteristics for all phases (though this plugin is set up to show total)
            const phases = ['A', 'B', 'C'];
            phases.forEach((phase, index) => {
                const serviceName = `Phase ${phase} Power`;
                const service = this.accessory.getService(serviceName);
                if (service) {
                    service.getCharacteristic(Characteristic.CurrentConsumption).updateValue(currentPower);
                    service.getCharacteristic(Characteristic.TotalConsumption).updateValue(totalEnergy);
                    this.log.debug(`Updated Phase ${phase} power to ${currentPower} W and energy to ${totalEnergy} kWh`);
                }
            });

        } catch (error) {
            this.log.error(`Failed to poll device ${this.device.name}: ${error.message}`);
        }

        setTimeout(() => this.pollStatus(), this.updateInterval);
    }
}
