import net from 'node:net';
const server = net.createServer(socket => socket.end());
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
await new Promise((resolve, reject) => net.connect(server.address().port, '127.0.0.1').once('error', reject).once('close', resolve));
await new Promise(resolve => server.close(resolve));
// Executed only inside the OS deny profile / isolated network namespace.
const denied = await new Promise(resolve => {
  const socket = net.connect({ host: '203.0.113.1', port: 9 });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', error => resolve(['EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
process.stdout.write(JSON.stringify({ loopback: true, externalDenied: denied }) + '\n');
process.exitCode = denied ? 0 : 1;
