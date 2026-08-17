const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db'); // Adjust path if db.js is elsewhere

// ---------------- REGISTER ----------------
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;

    // 1. Check if rider already exists
    const userCheck = await pool.query(
      'SELECT * FROM riders WHERE phone = $1',
      [phone]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Mobile number already registered.' });
    }

    // 2. Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Save new rider into PostgreSQL
    const newRider = await pool.query(
      'INSERT INTO riders (name, phone, password) VALUES ($1, $2, $3) RETURNING id, name, phone',
      [name, phone, hashedPassword]
    );

    const rider = newRider.rows[0];

    res.status(201).json({
      message: 'Registration successful!',
      rider,
      token: 'jwt-token-placeholder', // You can integrate JWT here later
    });
  } catch (err) {
    console.error('Registration Error:', err.message);
    res.status(500).json({ message: 'Server error during registration.' });
  }
});

// ---------------- LOGIN ----------------
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    // 1. Find rider by phone number
    const result = await pool.query(
      'SELECT * FROM riders WHERE phone = $1',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid phone number or password.' });
    }

    const rider = result.rows[0];

    // 2. Compare entered password with hashed password in database
    const isMatch = await bcrypt.compare(password, rider.password);

    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid phone number or password.' });
    }

    // 3. Password matched successfully
    res.json({
      message: 'Login successful!',
      rider: {
        id: rider.id,
        name: rider.name,
        phone: rider.phone,
      },
      token: 'jwt-token-placeholder',
    });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

module.exports = router;
