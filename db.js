const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ override: false });
}

console.log("Using Connection String:", process.env.DATABASE_URL);

// ONLY pass connectionString and ssl (remove PGUSER, PGHOST, PGDATABASE, etc.)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
  console.log("✅ Successfully connected to PostgreSQL database!");
});

pool.on('error', (err) => {
  console.error("❌ Unexpected database error:", err);
});

module.exports = pool;
