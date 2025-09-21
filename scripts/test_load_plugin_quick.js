const path = require('path');
const plugin = require(path.join('..','index.js'));
class FakeCharacteristic { constructor(name, uuid) { this.displayName = name; this.UUID = uuid; } setProps(){} getDefaultValue(){return null;} }
class FakeService { constructor(name){ this.displayName = name; } }
const fakeApi = { hap: { Service: FakeService, Characteristic: FakeCharacteristic }, registerAccessory: (n,c)=>console.log('reg',n) };
try { plugin(fakeApi); console.log('OK'); } catch(e) { console.error('ERR',e); process.exit(2); }
