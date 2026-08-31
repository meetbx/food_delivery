const { Server } = require('socket.io');
const { pool } = require('./db');
const {
  updateDriverLocation,
  removeDriverLocation,
  findNearbyDrivers
} = require('./services/deliveryService');

let io;
const activeDriverSockets = new Map();

// Track active 20-second offer timers per order
const offerTimers = new Map();

const cleanId = (id) => String(id || '').replace(/^(driver_|rider_)/, '');

/**
 * Fetch restaurant coordinates & order details directly from PostgreSQL
 */
async function getOrderRestaurant(orderId) {
  const result = await pool.query(`
    SELECT o.id, o.status, o.rider_id, o.user_id,
           o.delivery_address, o.delivery_latitude, o.delivery_longitude,
           o.final_total, o.items,
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

/**
 * Sequential Dispatcher (Combines Section 6 Redis Search + Socket Offer Logic)
 */
async function dispatchNextRider(orderId, excludedRiderIds = []) {
  if (offerTimers.has(orderId)) {
    clearTimeout(offerTimers.get(orderId));
    offerTimers.delete(orderId);
  }
  
  const order = await getOrderRestaurant(orderId);
  if (!order || ['Accepted', 'Picked Up', 'Delivered', 'Cancelled'].includes(order.status)) return null;

  const restLat = parseFloat(order.restaurant_latitude);
  const restLng = parseFloat(order.restaurant_longitude);

  console.log(`\n================= DISPATCH DIAGNOSTICS FOR ORDER ${orderId} =================`);
  console.log(`📍 Restaurant Location: Lat ${restLat}, Lng ${restLng}`);
  console.log(`🔌 Currently Registered Sockets in activeDriverSockets:`, Array.from(activeDriverSockets.keys()));

  if (isNaN(restLat) || isNaN(restLng)) {
    console.log(`❌ FAIL: Invalid restaurant latitude or longitude in DB.`);
    return null;
  }

  // 1. Check Redis Drivers
  const nearby = await findNearbyDrivers(restLng, restLat, 200);
  console.log(`🔍 Drivers returned by Redis GEOSEARCH (200km radius):`, nearby);

  if (!nearby || nearby.length === 0) {
    console.log(`❌ FAIL: Redis GEOSEARCH returned 0 drivers. Driver has not sent location to Redis yet.`);
    return null;
  }

  const excluded = new Set(excludedRiderIds.map(id => cleanId(id)));

  for (const candidate of nearby) {
    const rawRiderId = typeof candidate === 'object' ? (candidate.driverId || candidate.id) : candidate;
    const riderId = cleanId(rawRiderId);

    console.log(`--- Checking Candidate Rider ID: ${riderId} ---`);

    if (!riderId || excluded.has(riderId)) {
      console.log(`❌ SKIP: Rider ${riderId} is excluded or ID is invalid.`);
      continue;
    }

    if (!activeDriverSockets.has(riderId)) {
      console.log(`❌ SKIP: Rider ${riderId} is in Redis, but NOT in activeDriverSockets map (App did not emit 'register_rider').`);
      continue;
    }

    // DB Status check
    const riderResult = await pool.query(`
      SELECT r.id, r.name, r.status, r.last_latitude, r.last_longitude
      FROM riders r
      WHERE r.id = $1
    `, [riderId]);

    console.log(`📋 DB Record for Rider ${riderId}:`, riderResult.rows[0]);

    if (!riderResult.rows.length || riderResult.rows[0].status !== 'idle') {
      console.log(`❌ SKIP: Rider ${riderId} DB status is '${riderResult.rows[0]?.status}', expected 'idle'.`);
      continue;
    }

    // Insert offer into DB
    await pool.query(`
      INSERT INTO order_rider_offers (order_id, rider_id, status, offered_at)
      VALUES ($1, $2, 'offered', NOW())
      ON CONFLICT (order_id, rider_id)
      DO UPDATE SET status = 'offered', offered_at = NOW(), responded_at = NULL
    `, [orderId, riderId]);

    const payload = {
      orderId: Number(orderId),
      id: Number(orderId),
      restaurant: order.restaurant_name || 'Main Kitchen',
      restaurantAddress: order.restaurant_address || 'Main Kitchen Location',
      deliveryAddress: order.delivery_address || 'Customer Location',
      earnings: `₹${Math.round((order.final_total || 0) * 0.2) || 65}`,
      pickupDistance: `${Number(candidate.distanceKm || 1.2).toFixed(1)} km`,
      expiresInSeconds: 20
    };

    console.log(`✅ SUCCESS: Emitting offer for Order ${orderId} to rooms driver_${riderId} and rider_${riderId}`);
    io.to(`driver_${riderId}`).emit('new_order_offer', payload);
    io.to(`rider_${riderId}`).emit('new_order_offer', payload);

    return riderId;
  }

  console.log(`❌ FAIL: No candidates passed all checks.`);
  console.log(`===========================================================================\n`);
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

    // Register Rider Sockets & Update Status
    socket.on('register_rider', async ({ riderId, driverId }) => {
      const id = cleanId(riderId || driverId);
      if (!id) return;
      currentDriverId = id;
      activeDriverSockets.set(id, socket.id);

      try {
        await pool.query("UPDATE riders SET status = 'idle' WHERE id = $1 AND status <> 'delivering'", [id]);
      } catch (err) {
        console.error('[ONLINE STATUS ERROR]', err.message);
      }

      socket.join('active_riders');
      socket.join(`driver_${id}`);
      socket.join(`rider_${id}`);
    });

    // Real-Time GPS Location Updates
    socket.on('send_rider_location', async (data = {}) => {
      const id = cleanId(data.driverId || data.riderId || currentDriverId);
      const lat = parseFloat(data.lat);
      const lng = parseFloat(data.lng);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

      try {
        await updateDriverLocation(id, lng, lat);

        await pool.query(`
          UPDATE riders
          SET last_latitude = $1,
              last_longitude = $2,
              last_location_updated_at = NOW()
          WHERE id = $3
        `, [lat, lng, id]);

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

    // Accept Order Logic
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

        if (offerTimers.has(orderId)) {
          clearTimeout(offerTimers.get(orderId));
          offerTimers.delete(orderId);
        }

        await client.query("UPDATE orders SET rider_id = $1, status = 'Accepted' WHERE id = $2", [id, orderId]);
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

    // Decline Order Logic
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

socket.on('complete_delivery', async ({ riderId, driverId, orderId } = {}) => {
      // 1. Resolve clean driver ID from payload or fallback to socket session
      const id = cleanId(riderId || driverId || currentDriverId);

      if (!id || !orderId) {
        console.warn('⚠️ [COMPLETE DELIVERY FAIL] Missing orderId or riderId payload');
        return;
      }

      try {
        // 2. Mark order as Delivered
        await pool.query(
          "UPDATE orders SET status = 'Delivered' WHERE id = $1",
          [orderId]
        );

        // 3. Reset rider status back to 'idle' in DB
        const riderRes = await pool.query(
          "UPDATE riders SET status = 'idle' WHERE id = $1 RETURNING id, status",
          [id]
        );

        if (riderRes.rows.length > 0) {
          console.log(`✅ [DELIVERY COMPLETED] Order ${orderId} marked Delivered. Rider ${id} status set to 'idle'.`);
        } else {
          console.warn(`⚠️ [STATUS WARN] Could not find Rider ${id} in riders table.`);
        }

        // 4. Notify rider client that completion was successful
        socket.emit('delivery_completed_success', { orderId: Number(orderId) });

        // 5. Trigger dispatch check for any queued pending orders
        const pending = await pool.query(
          "SELECT id FROM orders WHERE status = 'Pending' AND rider_id IS NULL ORDER BY id ASC LIMIT 1"
        );
        if (pending.rows.length > 0) {
          await dispatchNextRider(pending.rows[0].id);
        }

      } catch (err) {
        console.error('❌ [COMPLETE DELIVERY ERROR]:', err.message);
      }
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
