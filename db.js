const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

// Add this line right before creating your Pool or Sequelize instance:
console.log("Attempting DB Connection to:", process.env.DATABASE_URL ? "URL provided" : "UNDEFINED");
console.log("Full DB String (First 20 chars):", process.env.DATABASE_URL?.substring(0, 20));

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});




module.exports = pool;
