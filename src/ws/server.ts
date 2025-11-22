import { Server } from 'socket.io';
import { config } from '../config';
import Redis from 'ioredis';
import { CHANNELS } from '../redis';

const io = new Server({
  cors: { origin: '*' }
});

const sub = new Redis(config.redisUrl);

sub.subscribe(CHANNELS.batchProgress, (err) => {
  if (err) console.error('Redis subscribe error:', err);
});

sub.on('message', (channel, message) => {
  if (channel === CHANNELS.batchProgress) {
    try {
      const payload = JSON.parse(message);
      io.emit('batch_progress', payload);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  }
});

io.listen(config.wsPort);
console.log(`WebSocket server listening on port ${config.wsPort}`);