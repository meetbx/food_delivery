const express = require('express');
const router = express.Router();

// Import your PostgreSQL pool or client (e.g., const db = require('../db');)
const db = require('../db'); 

/**
 * GET /api/trial/:orderId
 * Fetches real restaurant and customer delivery coordinates for trial tracking.
 */
router.get('/trial/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    // PostgreSQL Query matching crave_db schema
    const query = `
      SELECT 
        o.id AS order_id,
        o.status,
        o.delivery_address,
        r.name AS restaurant_name,
        r.latitude AS restaurant_lat,
        r.longitude AS restaurant_lng,
        COALESCE(u.latitude, 12.9716) AS customer_lat,   -- Falls back to default if null
        COALESCE(u.longitude, 77.5946) AS customer_lng   -- Falls back to default if null
      FROM public.orders o
      JOIN public.restaurants r ON o.restaurant_id = r.id
      LEFT JOIN public.users u ON o.user_id = u.id
      WHERE o.id = $1
    `;

    const result = await db.query(query, [orderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found in crave_db' });
    }

    const order = result.rows[0];

    res.json({
      orderId: order.order_id,
      status: order.status,
      deliveryAddress: order.delivery_address,
      restaurant: {
        name: order.restaurant_name,
        lat: parseFloat(order.restaurant_lat),
        lng: parseFloat(order.restaurant_lng),
      },
      customer: {
        lat: parseFloat(order.customer_lat),
        lng: parseFloat(order.customer_lng),
      },
    });
  } catch (error) {
    console.error('Error fetching trial order data:', error);
    res.status(500).json({ error: 'Database server error' });
  }
});

module.exports = router;