import dotenv from 'dotenv';
import path from 'path';
// Load base env, then optionally override with .env.local for host/dev setups
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://csi:csi_password@localhost:5432/csi_db',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  apiPort: Number(process.env.API_PORT || 3000),
  wsPort: Number(process.env.WS_PORT || 3001),
  frontendPort: Number(process.env.FRONTEND_PORT || 3002),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  ninjaKeys: (process.env.NINJA_KEYS || '').split(',').filter(Boolean),
  ninjaRateLimit: Number(process.env.NINJA_RATE_LIMIT || 35),
  ninjaIntervalMs: Number(process.env.NINJA_INTERVAL || 30_000),
  ninjaDelayMs: Math.max(170, Math.floor(Number(process.env.NINJA_INTERVAL || 30_000) / Number(process.env.NINJA_RATE_LIMIT || 35))),
  ninjaDisableThreshold: Number(process.env.NINJA_DISABLE_THRESHOLD || 100),
  bloomKey: process.env.BLOOM_KEY || 'emails_bloom',
  uploadDir: process.env.UPLOAD_DIR || '/usr/src/app/uploads',
  exportDir: process.env.EXPORT_DIR || '/usr/src/app/exports',
  downloadDir: process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'storage', 'downloads'),
  logLevel: process.env.LOG_LEVEL || 'info'
};
