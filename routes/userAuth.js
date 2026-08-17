const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {pool} = require('../db');
const { verifyCustomerToken } = require('../middleware/authMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || '4a89f2c38b1e8f9076543210abcd1234ef567890abcdef1234567890abcdef12';

// CUSTOMER REGISTER
router.post('/register', async (req, res) => {
  const { name, phone, email, password, latitude, longitude, current_address } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, Phone number, and Password are required.' });
  }

  try {
    // Check if phone already registered
    const existingUser = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered. Please login.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user with location fields
    const newUser = await pool.query(
      `INSERT INTO users (name, phone, email, password, latitude, longitude, current_address) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING id, name, phone, email, latitude, longitude, current_address, created_at`,
      [
        name, 
        phone, 
        email || null, 
        hashedPassword, 
        latitude || null, 
        longitude || null, 
        current_address || null
      ]
    );

    const user = newUser.rows[0];
    const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user
    });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// CUSTOMER LOGIN
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone number and Password are required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid phone number or password.' });
    }

    const user = result.rows[0];

    // Verify Password
    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid phone number or password.' });
    }

    const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });

    delete user.password; // Exclude password from response

    res.json({
      message: 'Login successful',
      token,
      user // includes user.latitude, user.longitude, user.current_address
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// GET CURRENT USER PROFILE (Includes GPS Coordinates & Address)
router.get('/me', verifyCustomerToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, latitude, longitude, current_address, created_at 
       FROM users 
       WHERE id = $1`, 
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(440).json({ error: 'User not found.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching user details.' });
  }
});

// UPDATE USER LOCATION
router.put('/location', verifyCustomerToken, async (req, res) => {
  try {
    const { latitude, longitude, current_address } = req.body;

    const result = await pool.query(
      `UPDATE users 
       SET latitude = $1, longitude = $2, current_address = $3 
       WHERE id = $4 
       RETURNING id, name, phone, email, latitude, longitude, current_address, created_at`,
      [latitude, longitude, current_address, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Location Update Error:', error);
    res.status(500).json({ error: 'Server error updating user location.' });
  }
});

module.exports = router;
