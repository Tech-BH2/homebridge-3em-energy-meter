const path = require('path');
const plugin = require(path.join('..','index.js'));
// Create a minimal fake hap with Service and Characteristic constructors
class FakeCharacteristic {
	constructor(name, uuid) { this.displayName = name; this.UUID = uuid; }
	setProps() {}
	getDefaultValue() { return null; }
}
class FakeService {
	constructor(name) { this.displayName = name; }
}
const fakeApi = {
	hap: {
		Service: FakeService,
		Characteristic: FakeCharacteristic
	}
};
// stub registerAccessory used by the plugin
fakeApi.registerAccessory = function(name, constructor) {
	console.log('registerAccessory called for', name);
};
try {
	plugin(fakeApi);
	console.log('Plugin loaded without throwing');
} catch (e) {
	console.error('Plugin threw on load:', e);
	process.exit(2);
}
