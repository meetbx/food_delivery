const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ override: false });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Always allow SSL for Render/External PostgreSQL
  }
});

// Test connection on server startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL connection error:', err);
  } else {
    console.log('✅ Connected to PostgreSQL successfully at:', res.rows[0].now);
  }
});

module.exports = pool;
