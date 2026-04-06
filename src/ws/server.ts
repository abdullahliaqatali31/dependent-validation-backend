import { Server } from 'socket.io';
import { config } from '../config';
import Redis from 'ioredis';
import { CHANNELS } from '../redis';

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
  'http://localhost:3005',
];

const io = new Server({
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost:')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
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