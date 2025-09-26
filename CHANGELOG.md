# Change Log

## 2.0 
Homebridge 3EM Energy Meter Plugin - Homebridge 2.0 Compatibility Update

This document outlines the changes made to ensure compatibility with Homebridge 2.0 while maintaining functionality for recording electrical consumption data in the Eve app for iOS.


Changes Made

1. Package.json Updates
• Updated `engines` field to support Homebridge 2.0: `"homebridge": ">=1.3.1 || ^2.0.0"`
• Updated minimum Node.js version to 14.0.0
• Replaced deprecated `request` package with `axios` (v1.6.7)
• Incremented version number to 1.2.0


2. Index.js Updates
• Replaced the deprecated `request` package with modern `axios` for HTTP requests
• Updated the HTTP request handling code to use promises and async/await pattern
• Modified authentication handling to match axios requirements
• Improved error handling with proper promise rejection
• Maintained all existing functionality while ensuring compatibility with Homebridge 2.0


3. Config.schema.json
• Maintained the existing schema structure which is already compatible with Homebridge 2.0
• Ensured all required fields and validations are properly defined


Benefits of These Changes
1. **Improved Security**: Replaced the deprecated `request` package with the actively maintained `axios` package
2. **Better Performance**: Modern HTTP request handling with promises provides better performance
3. **Future-Proofing**: Compatibility with both Homebridge 1.x and 2.0
4. **Maintained Functionality**: All existing features continue to work as expected
5. **Better Error Handling**: Improved error reporting and handling


Installation

To install the updated plugin:

1. Update your existing plugin:
```
npm update -g homebridge-3em-energy-meter
```

2. Or install fresh:
```
npm install -g homebridge-3em-energy-meter
```

3. Restart Homebridge


Compatibility

This updated version is compatible with:
• Homebridge 1.3.1 and above
• Homebridge 2.0
• Node.js 14.0.0 and above
• Eve app for iOS
• Shelly 3EM and Shelly EM devices




## 1.1.3 (2021-05-18)

### Changes

* Added a mode selection in order to specify what to do when negative values appear (Power returns etc.).


## 1.1.2 (2021-11-02)

### Changes

* Added correct absolute ( abs() ) to calculations in order to comply to Homekit ranges (no negative values allowed).

## 1.1.1 (2021-11-02)

### Changes

* Added absolute ( abs() ) to calculations in order to comply to Homekit ranges (no negative values allowed).

## 1.1.0 (2021-08-02)

### Changes

* Added support for Shelly EM devices (beta)
* Please set config flag use_em to true and 
  use use_em_mode to get combined, channel1 or channel2 (setting 0,1,2)
  to use this plugin with a Shelly EM.

## 1.0.0 (2021-06-11)

### Changes

* Bumped stable and tested release to major version 1.0.0
* Just added donation button ;)

## 0.1.3 (2021-04-21)

### Changes

* Added option to use the Power Factor (pf) when calculating Total Ampere.


## 0.1.2 (2021-04-10)

### Changes

* Added returned metered values to debug log.

