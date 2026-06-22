const dgram = require('node:dgram');
const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  const reply = Buffer.from(`ECHO:${msg.toString()}`);
  server.send(reply, rinfo.port, rinfo.address, (err) => {
    if (err) console.error('Send error:', err);
  });
});

server.on('listening', () => {
  const _addr = server.address();
});

server.bind(9999, '0.0.0.0');
