const dgram = require('dgram');
const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  const reply = Buffer.from(`ECHO:${msg.toString()}`);
  server.send(reply, rinfo.port, rinfo.address, (err) => {
    if (err) console.error('Send error:', err);
  });
  console.log(`Echoed ${msg.length} bytes to ${rinfo.address}:${rinfo.port}`);
});

server.on('listening', () => {
  const addr = server.address();
  console.log(`UDP echo server listening on ${addr.address}:${addr.port}`);
});

server.bind(9999, '0.0.0.0');
