const request = require('request');

const ip = process.argv[2];
const user = process.argv[3];
const pass = process.argv[4];

if (!ip) {
  console.error('Usage: node scripts/get_shelly_status.js <IP> [user] [pass]');
  process.exit(2);
}

const url = `http://${ip}/status/emeters?`;
const ops = { uri: url, method: 'GET', timeout: 5000 };
if (user && pass) ops.auth = { user, pass };

console.log('Requesting:', url);
request(ops, (err, res, body) => {
  if (err) {
    console.error('Request error:', err.message || err);
    process.exit(1);
  }
  console.log('HTTP status:', res && res.statusCode);
  try {
    const json = JSON.parse(body);
    console.log('JSON response:');
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.log('Non-JSON response body:');
    console.log(body);
  }
});
