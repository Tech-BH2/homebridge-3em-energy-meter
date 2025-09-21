const path = require('path');
const plugin = require(path.join('..','index.js'));
class FakeCharacteristic { constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.props={}; } setProps(p){ this.props=p } getDefaultValue(){return null} setValue(v, a, cb){ if(cb) cb(null)} on(ev,fn){} }
class FakeService { constructor(name){ this.displayName = name; this.characteristics = []; } addCharacteristic(c){ if (typeof c === 'function') { const inst = new c(); this.characteristics.push(inst); return inst; } this.characteristics.push(c); return c; } getCharacteristic(c){ return this.characteristics.find(x=>x.UUID=== (c.UUID||c)); } updateCharacteristic(){}
}
const fakeApi = { hap: { Service: FakeService, Characteristic: FakeCharacteristic }, registerAccessory: (n,c)=>console.log('reg',n) };
try { plugin(fakeApi); console.log('OK'); } catch(e) { console.error('ERR',e); process.exit(2); }
