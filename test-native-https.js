import https from 'https';
import fs from 'fs';

console.log('Testing native HTTPS module...');

const httpsAgent = new https.Agent({
  key: fs.readFileSync('./scripts/certs/proxy.key'),
  cert: fs.readFileSync('./scripts/certs/proxy.crt'),
  ca: fs.readFileSync('./scripts/certs/ca.crt'),
  rejectUnauthorized: true,
  keepAlive: true
});

const options = {
  hostname: 'consensus.canister.software',
  port: 8888,
  path: '/',
  method: 'GET',
  agent: httpsAgent
};

const req = https.request(options, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Success:', json.name);
    } catch (e) {
      console.log('Response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
  console.error('Error details:', error);
});

req.end();
