import { Server } from 'socket.io';
import { config } from '../config';
import Redis from 'ioredis';
import { CHANNELS } from '../redis';
import { createClient } from '@supabase/supabase-js';

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
  'http://localhost:3005',
  ...(process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
];

const supabaseAdmin = (config.supabaseUrl && config.supabaseServiceRoleKey)
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
  : null;

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

// Require a valid token to connect
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  if (supabaseAdmin) {
    try {
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !user) return next(new Error('unauthorized'));
      (socket as any).userId = user.id;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  }
  // Dev fallback: accept any token with a parseable sub
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (payload.sub) { (socket as any).userId = payload.sub; return next(); }
    }
  } catch {}
  return next(new Error('unauthorized'));
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
