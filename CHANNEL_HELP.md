Quick helper: how to add per-channel accessories for Shelly 3EM

Homebridge's Config UI cannot automatically create multiple accessory instances from a single accessory entry. This plugin provides helper options in the UI that show example config snippets you can paste into your `config.json` or use to create new accessory entries in the UI.

Example accessory snippets

- Channel 1 (emeter index 0)
{
  "accessory": "3EMEnergyMeterChannel",
  "name": "Shelly 3EM - Channel 1",
  "ip": "192.168.2.95",
  "channelIndex": 0,
  "update_interval": 10000,
  "debug_log": false,
  "serial": "YOUR-SHELLY-SERIAL"
}

- Channel 2 (emeter index 1)
{
  "accessory": "3EMEnergyMeterChannel",
  "name": "Shelly 3EM - Channel 2",
  "ip": "192.168.2.95",
  "channelIndex": 1,
  "update_interval": 10000,
  "debug_log": false,
  "serial": "YOUR-SHELLY-SERIAL"
}

- Channel 3 (emeter index 2)
{
  "accessory": "3EMEnergyMeterChannel",
  "name": "Shelly 3EM - Channel 3",
  "ip": "192.168.2.95",
  "channelIndex": 2,
  "update_interval": 10000,
  "debug_log": false,
  "serial": "YOUR-SHELLY-SERIAL"
}

Instructions

1. Open Homebridge UI -> Plugins -> Your plugin settings.
2. Toggle "Add channel-specific accessory (UI helper)" and check the channels you want to expose. The UI will display these example snippets.
3. Copy the snippet for the channel you want and paste it into your `config.json` under the `accessories` array, or create a new accessory in the UI matching those fields.
4. Restart Homebridge. The new accessory should appear and start polling.

Notes

- Each channel accessory polls the Shelly independently. If you prefer one shared poller for performance, I can refactor the plugin into a platform that shares polling across created accessories.
- Make sure `serial` is unique per accessory to avoid HomeKit cached accessory conflicts; append `-ch1` etc. if needed.
