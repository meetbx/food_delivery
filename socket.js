const { Server } = require('socket.io');
const { pool } = require('./db');
const {
  updateDriverLocation,
  removeDriverLocation,
  findNearbyDrivers
} = require('./services/deliveryService');

let io;
const activeDriverSockets = new Map();

const cleanId = (id) => String(id || '').replace(/^(driver_|rider_)/, '');
// Keep track of active 20-second offer timers per order
const offerTimers = new Map();

async function getOrderRestaurant(orderId) {
  const result = await pool.query(`
    SELECT o.id, o.status, o.rider_id,
           o.delivery_address, o.final_total,
           r.name AS restaurant_name,
           r.address AS restaurant_address,
           r.latitude AS restaurant_latitude,
           r.longitude AS restaurant_longitude
    FROM orders o
    LEFT JOIN restaurants r ON r.id = o.restaurant_id
    WHERE o.id = $1
  `, [orderId]);
  return result.rows[0] || null;
}

async function dispatchNextRider(orderId, excludedRiderIds = []) {
  // Clear any existing timer for this order
  if (offerTimers.has(orderId)) {
    clearTimeout(offerTimers.get(orderId));
    offerTimers.delete(orderId);
  }
  
  const order = await getOrderRestaurant(orderId);
  if (!order || ['Accepted', 'Picked Up', 'Delivered', 'Cancelled'].includes(order.status)) return null;

  const restLat = parseFloat(order.restaurant_latitude);
  const restLng = parseFloat(order.restaurant_longitude);
  if (isNaN(restLat) || isNaN(restLng)) return null;

  const excluded = new Set(excludedRiderIds.map(id => cleanId(id)));
  if (order.rider_id) excluded.add(cleanId(order.rider_id));

// Exclude riders who already declined, expired, or accepted
  const priorOffers = await pool.query(`
    SELECT rider_id FROM order_rider_offers
    WHERE order_id = $1 AND status IN ('declined', 'expired', 'accepted')
  `, [orderId]);
  priorOffers.rows.forEach(row => excluded.add(cleanId(row.rider_id)));

  // Find nearby drivers via Redis GEOSEARCH
  const nearby = await findNearbyDrivers(restLng, restLat, 10);

  for (const candidate of nearby) {
    const riderId = cleanId(candidate.driverId);
    if (!riderId || excluded.has(riderId)) continue;
    if (!activeDriverSockets.has(riderId)) continue;

    // Filter by rider status = 'idle'
    const riderResult = await pool.query(`
      SELECT r.id, r.name, r.last_latitude, r.last_longitude
      FROM riders r
      WHERE r.id = $1
        AND r.status = 'idle'
        AND NOT EXISTS (
          SELECT 1 FROM orders ao
          WHERE ao.rider_id = r.id
            AND ao.status IN ('Accepted', 'Picked Up', 'Out for Delivery')
        )
    `, [riderId]);

    if (!riderResult.rows.length) continue;

    // Track the offer in DB
    await pool.query(`
      INSERT INTO order_rider_offers (order_id, rider_id, status, offered_at)
      VALUES ($1, $2, 'offered', NOW())
      ON CONFLICT (order_id, rider_id)
      DO UPDATE SET status = 'offered', offered_at = NOW(), responded_at = NULL
    `, [orderId, riderId]);

    const payload = {
      orderId: Number(orderId),
      id: Number(orderId),
      restaurant: order.restaurant_name || 'Restaurant',
      restaurantAddress: order.restaurant_address || 'Restaurant Location',
      deliveryAddress: order.delivery_address || 'Customer Location',
      earnings: `₹${Math.round((order.final_total || 0) * 0.2) || 65}`,
      pickupDistance: `${Number(candidate.distanceKm).toFixed(1)} km`,
      distanceKm: candidate.distanceKm,
      expiresInSeconds: 20,
      riderLocation: {
        lat: parseFloat(riderResult.rows[0].last_latitude),
        lng: parseFloat(riderResult.rows[0].last_longitude)
      }
    };

    // Send payload exclusively to candidate rider
    io.to(`driver_${riderId}`).emit('new_order_offer', payload);
    io.to(`rider_${riderId}`).emit('new_order_offer', payload);

    // 20-Second Timeout: Auto-expire and move to next rider
    const timer = setTimeout(async () => {
      await pool.query(`
        UPDATE order_rider_offers
        SET status = 'expired', responded_at = NOW()
        WHERE order_id = $1 AND rider_id = $2 AND status = 'offered'
      `, [orderId, riderId]);

      io.to(`driver_${riderId}`).emit('offer_expired', { orderId: Number(orderId) });
      io.to(`rider_${riderId}`).emit('offer_expired', { orderId: Number(orderId) });

      // Trigger dispatch to the next closest driver
      dispatchNextRider(orderId, [riderId]);
    }, 20000);

    offerTimers.set(orderId, timer);
    return riderId;
  }

  return null;
}

const initSocket = (server) => {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH'] }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket Connected]: ${socket.id}`);
    let currentDriverId = null;

    const joinOrder = ({ orderId }) => {
      if (!orderId) return;
      socket.join(`order_${orderId}`);
      console.log(`Socket ${socket.id} joined order_${orderId}`);
    };

    socket.on('join_order_room', joinOrder);
    socket.on('join_trial_room', joinOrder);

socket.on('register_rider', async ({ riderId, driverId }) => {
  const id = cleanId(riderId || driverId);
  if (!id) return;
  currentDriverId = id;
  activeDriverSockets.set(id, socket.id);

  try {
    // Set rider status to idle if they aren't on an active delivery
    await pool.query("UPDATE riders SET status = 'idle' WHERE id = $1 AND status <> 'delivering'", [id]);
  } catch (err) {
    console.error('[ONLINE STATUS ERROR]', err.message);
  }

  socket.join('active_riders');
  socket.join(`driver_${id}`);
  socket.join(`rider_${id}`);
});

    socket.on('send_rider_location', async (data = {}) => {
      const id = cleanId(data.driverId || data.riderId || currentDriverId);
      const lat = parseFloat(data.lat);
      const lng = parseFloat(data.lng);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

      try {
        // Redis = fast live geo index.
        await updateDriverLocation(id, lng, lat);

        // PostgreSQL = authoritative latest location + timestamp.
        await pool.query(`
          UPDATE riders
          SET last_latitude = $1,
              last_longitude = $2,
              last_location_updated_at = NOW()
          WHERE id = $3
        `, [lat, lng, id]);

        // If this rider has an accepted order, broadcast every GPS update to that order.
        const activeOrder = await pool.query(`
          SELECT id, status
          FROM orders
          WHERE rider_id = $1
            AND status IN ('Accepted', 'Picked Up', 'Out for Delivery')
          ORDER BY id DESC
          LIMIT 1
        `, [id]);

        if (activeOrder.rows.length) {
          const orderId = activeOrder.rows[0].id;
          io.to(`order_${orderId}`).emit('rider_location_updated', {
            orderId,
            riderId: Number(id),
            lat,
            lng,
            timestamp: Date.now()
          });
        }
      } catch (err) {
        console.error('[LOCATION ERROR]', err.message);
      }
    });

  socket.on('accept_order', async ({ orderId, riderId, driverId }) => {
      const id = cleanId(riderId || driverId || currentDriverId);
      if (!orderId || !id) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const orderResult = await client.query(`
          SELECT id, status, rider_id FROM orders WHERE id = $1 FOR UPDATE
        `, [orderId]);

        if (!orderResult.rows.length) throw new Error('Order not found');
        const order = orderResult.rows[0];

        if (order.rider_id || order.status !== 'Pending') {
          await client.query('ROLLBACK');
          socket.emit('order_accept_failed', { orderId, message: 'Order is no longer available.' });
          return;
        }

        // Cancel 20s timeout timer
        if (offerTimers.has(orderId)) {
          clearTimeout(offerTimers.get(orderId));
          offerTimers.delete(orderId);
        }

        // Assign order and update status
        await client.query("UPDATE orders SET rider_id = $1, status = 'Accepted' WHERE id = $2", [id, orderId]);
        
        // Update rider status to 'delivering' so they don't receive new offers
        await client.query("UPDATE riders SET status = 'delivering' WHERE id = $1", [id]);

        await client.query(`
          INSERT INTO order_rider_offers (order_id, rider_id, status, responded_at)
          VALUES ($1, $2, 'accepted', NOW())
          ON CONFLICT (order_id, rider_id)
          DO UPDATE SET status = 'accepted', responded_at = NOW()
        `, [orderId, id]);

        await client.query('COMMIT');

        io.to(`order_${orderId}`).emit('order_accepted', { orderId: Number(orderId), riderId: Number(id) });
        socket.emit('order_accept_success', { orderId: Number(orderId) });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        socket.emit('order_accept_failed', { orderId, message: err.message });
      } finally {
        client.release();
      }
    });

    socket.on('decline_order', async ({ orderId, riderId, driverId }) => {
      const id = cleanId(riderId || driverId || currentDriverId);
      if (!orderId || !id) return;

      if (offerTimers.has(orderId)) {
        clearTimeout(offerTimers.get(orderId));
        offerTimers.delete(orderId);
      }

      await pool.query(`
        INSERT INTO order_rider_offers (order_id, rider_id, status, responded_at)
        VALUES ($1, $2, 'declined', NOW())
        ON CONFLICT (order_id, rider_id)
        DO UPDATE SET status = 'declined', responded_at = NOW()
      `, [orderId, id]);

      await dispatchNextRider(orderId, [id]);
    });

    socket.on('complete_delivery', async ({ riderId, orderId }) => {
      const id = cleanId(riderId || currentDriverId);
      // Mark delivery complete & set rider back to 'idle'
      await pool.query("UPDATE orders SET status = 'Delivered' WHERE id = $1", [orderId]);
      await pool.query("UPDATE riders SET status = 'idle' WHERE id = $1", [id]);
    });

    socket.on('driver_offline', async ({ driverId, riderId } = {}) => {
      const id = cleanId(driverId || riderId || currentDriverId);
      if (!id) return;
      activeDriverSockets.delete(id);
      await removeDriverLocation(id);
      await pool.query("UPDATE riders SET status = 'offline' WHERE id = $1", [id]);
    });
  });

  return io;
};


const getIo = () => {
  if (!io) throw new Error('Socket.io has not been initialized!');
  return io;
};

module.exports = { initSocket, getIo, dispatchNextRider };
