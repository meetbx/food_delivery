const express = require('express');
const router = express.Router();
const {pool} = require('../db'); // Adjust path to your db pool file
const { verifyCustomerToken } = require('../middleware/authMiddleware'); // Adjust path to auth middleware

// 1. GET ALL SAVED ADDRESSES FOR LOGGED-IN USER
router.get('/', verifyCustomerToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT 
        id, 
        user_id AS customer_id, 
        full_address AS address, 
        house_no,
        latitude, 
        longitude, 
        label AS tag, 
        city,
        phone,
        is_default 
       FROM addresses 
       WHERE user_id = $1 
       ORDER BY is_default DESC, id DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer addresses:', error);
    res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

// 2. ADD NEW ADDRESS (POST ROUTE)
router.post('/', verifyCustomerToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      address, 
      house_no = '',
      city = 'Default City',
      pincode = '000000',
      phone = '0000000000',
      latitude = null, 
      longitude = null, 
      place_id = null, 
      tag = 'Home', 
      is_default = false 
    } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required.' });
    }

    // If marked as default, reset other addresses for this user
    if (is_default) {
      await pool.query(`UPDATE addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }

    const query = `
      INSERT INTO addresses (user_id, full_address, house_no, city, phone, latitude, longitude, label, is_default)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, user_id AS customer_id, full_address AS address, house_no, city, phone, latitude, longitude, label AS tag, is_default;
    `;

    const values = [userId, address, house_no, city, phone, latitude, longitude, tag, is_default];
    const newAddress = await pool.query(query, values);

    res.status(201).json(newAddress.rows[0]);
  } catch (error) {
    console.error('Error saving address:', error);
    res.status(500).json({ error: 'Failed to save address' });
  }
});

// 3. DELETE ADDRESS
router.delete('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const addressId = req.params.id;

    const result = await pool.query(
      `DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id`,
      [addressId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Address not found or unauthorized' });
    }

    res.json({ message: 'Address deleted successfully', id: addressId });
  } catch (error) {
    console.error('Error deleting address:', error);
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

module.exports = router;
