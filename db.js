// 1. Load environment variables FIRST
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ override: false });
}

const { Pool } = require('pg');
const Redis = require('ioredis');

// 2. Initialize Redis
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redis = new Redis(redisUrl, {
  enableOfflineQueue: false, // STOP INFINITE LOADING: Fails fast if Redis is disconnected
  connectTimeout: 5000,      // Times out connection attempts after 5 seconds
  maxRetriesPerRequest: 1,   // Rejects failed commands instead of hanging requests
  keepAlive: 10000,
  tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});

let isConnected = false;

// Fires only when the connection is ready for commands
redis.on('ready', () => {
  if (!isConnected) {
    console.log('✅ Redis connected and ready');
    isConnected = true;
  }
});

// Quietly handle routine connection resets during auto-reconnect
redis.on('error', (err) => {
  if (err.code === 'ECONNRESET') {
    return; // Prevents log spam when server drops idle connections
  }
  console.error('❌ Redis Connection Error:', err.message);
});

// 3. Initialize PostgreSQL
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

// Test PostgreSQL connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL connection error:', err);
  } else {
    console.log('✅ Connected to PostgreSQL successfully at:', res.rows[0].now);
  }
});

// 4. Export both clients together
module.exports = {
  pool,
  redis
};
