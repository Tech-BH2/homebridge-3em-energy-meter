Energy-only accessory (Homebridge plugin)

This plugin now includes a second accessory type that exposes Eve-compatible energy characteristics and FakeGato history as a standalone accessory.

How to add it to Homebridge:

1. In your `config.json` add a second accessory entry for the same plugin with the type `3EMEnergyMeterEnergy` (plugin name and accessory name depend on how you install/register the plugin).

Example (platform-style config may differ depending on your Homebridge setup):

{
  "accessories": [
    {
      "accessory": "3EMEnergyMeterEnergy",
      "name": "EM - energy only",
      "ip": "192.168.2.95",
      "update_interval": 10000,
      "debug_log": true
    }
  ]
}

2. Restart Homebridge. The new accessory will appear separately and publish Eve energy characteristics and FakeGato history.

Notes:
- This accessory is reversible; remove the entry to stop it.
- Keep `debug_log` enabled while testing so you can see detailed logs.

If you'd like, I can also add this accessory automatically when the main accessory is configured (behind a config flag).