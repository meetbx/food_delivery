// 1. Load environment variables FIRST
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ override: false });
}

const { Pool } = require('pg');
const Redis = require('ioredis');

// 2. Initialize Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Required if using cloud providers like Upstash or Redis Cloud using SSL (rediss://)
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined
});

redis.on('connect', () => console.log('✅ Redis connected successfully'));
redis.on('error', (err) => console.error('❌ Redis connection error:', err));

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
