const plugin = require('../index.js');
class C{constructor(n){this.displayName=n;this.characteristics=[]}addCharacteristic(c){if(typeof c==='function'){const inst=new c();this.characteristics.push(inst);return inst}this.characteristics.push(c);return c}getCharacteristic(c){return this.characteristics.find(x=>x.UUID=== (c.UUID||c))}
}
class Char{constructor(n,u){this.displayName=n;this.UUID=u}setProps(){}getDefaultValue(){return null}setValue(){}
}
const fakeApi={hap:{Service:C, Characteristic:Char}, registerAccessory:(n,c)=>console.log('register',n)};
try{plugin(fakeApi);console.log('OK')}catch(e){console.error(e);process.exit(2)}
