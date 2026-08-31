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
  // 1. Clear any existing active timer for this order
  if (offerTimers.has(orderId)) {
    clearTimeout(offerTimers.get(orderId));
    offerTimers.delete(orderId);
  }
  
  // 2. Fetch order & restaurant details
  const order = await getOrderRestaurant(orderId);
  if (!order || ['Accepted', 'Picked Up', 'Delivered', 'Cancelled'].includes(order.status)) {
    return null;
  }

  const restLat = parseFloat(order.restaurant_latitude);
  const restLng = parseFloat(order.restaurant_longitude);
  
  // Fallback: If restaurant lat/lng doesn't exist, exit safely
  if (isNaN(restLat) || isNaN(restLng)) {
    console.warn(`⚠️ [DISPATCH FAIL] Invalid restaurant coordinates for Order ${orderId}`);
    return null;
  }

  // 3. Build exclusion set (Declined, Expired, Accepted, or explicitly passed riders)
  const excluded = new Set(excludedRiderIds.map(id => cleanId(id)));
  if (order.rider_id) excluded.add(cleanId(order.rider_id));

  const priorOffers = await pool.query(`
    SELECT rider_id FROM order_rider_offers
    WHERE order_id = $1 AND status IN ('declined', 'expired', 'accepted')
  `, [orderId]);
  priorOffers.rows.forEach(row => excluded.add(cleanId(row.rider_id)));

  // 4. Redis GEOSEARCH: Find drivers within 200 km radius (as specified in Section 6)
  const SEARCH_RADIUS_KM = 200;
  const nearbyCandidates = await findNearbyDrivers(restLng, restLat, SEARCH_RADIUS_KM);

  if (!nearbyCandidates || nearbyCandidates.length === 0) {
    console.log(`⚠️ [DISPATCH] No nearby drivers found in Redis within ${SEARCH_RADIUS_KM}km for Order ${orderId}`);
    return null;
  }

  // 5. Calculate item counts safely
  let rawItems = order.items || [];
  if (typeof rawItems === 'string') {
    try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
  }
  const itemsCount = Array.isArray(rawItems) ? rawItems.length : 1;

  // 6. Iterate candidates sequentially to find an eligible connected driver
  for (const candidate of nearbyCandidates) {
    const rawRiderId = typeof candidate === 'object' ? (candidate.driverId || candidate.id) : candidate;
    const riderId = cleanId(rawRiderId);

    if (!riderId || excluded.has(riderId)) continue;
    if (!activeDriverSockets.has(riderId)) continue; // Must have an active socket connection

    // 7. Verify DB status: Driver must be 'idle' and not currently on an active delivery
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

    // 8. Record the offer attempt in DB
    await pool.query(`
      INSERT INTO order_rider_offers (order_id, rider_id, status, offered_at)
      VALUES ($1, $2, 'offered', NOW())
      ON CONFLICT (order_id, rider_id)
      DO UPDATE SET status = 'offered', offered_at = NOW(), responded_at = NULL
    `, [orderId, riderId]);

    // 9. Format Section 6 Payload complete with calculated earnings & distances
    const calcTotal = Number(order.final_total || 0);
    const distanceKmVal = candidate.distanceKm ? Number(candidate.distanceKm) : 1.2;

    const payload = {
      orderId: Number(orderId),
      id: Number(orderId),
      restaurant: order.restaurant_name || 'Main Kitchen',
      restaurantAddress: order.restaurant_address || 'Main Kitchen Location',
      deliveryAddress: order.delivery_address || 'Customer Location',
      earnings: `₹${Math.round(calcTotal * 0.2) || 65}`,
      pickupDistance: `${distanceKmVal.toFixed(1)} km`,
      dropDistance: '3.5 km',
      distanceKm: distanceKmVal,
      itemsCount,
      expiresInSeconds: 20,
      lat: parseFloat(order.delivery_latitude),
      lng: parseFloat(order.delivery_longitude),
      roomName: `order_${orderId}`,
      riderLocation: {
        lat: parseFloat(riderResult.rows[0].last_latitude),
        lng: parseFloat(riderResult.rows[0].last_longitude)
      }
    };

    // 10. Emit directly to driver sockets
    console.log(`📡 [EMIT TARGET] Dispatching Order ${orderId} offer to Rider ID: ${riderId}`);
    io.to(`driver_${riderId}`).emit('new_order_offer', payload);
    io.to(`rider_${riderId}`).emit('new_order_offer', payload);

    // 11. 20-Second Offer Expiration Timer
    const timer = setTimeout(async () => {
      console.log(`⏰ Offer timed out for Order ${orderId} -> Rider ${riderId}. Rotating to next driver...`);
      await pool.query(`
        UPDATE order_rider_offers
        SET status = 'expired', responded_at = NOW()
        WHERE order_id = $1 AND rider_id = $2 AND status = 'offered'
      `, [orderId, riderId]);

      io.to(`driver_${riderId}`).emit('offer_expired', { orderId: Number(orderId) });
      io.to(`rider_${riderId}`).emit('offer_expired', { orderId: Number(orderId) });

      // Trigger dispatch to the next closest candidate
      dispatchNextRider(orderId, [riderId]);
    }, 20000);

    offerTimers.set(orderId, timer);
    return riderId;
  }

  console.log(`⚠️ No available idle riders accepted or matched for Order ${orderId}`);
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

    socket.on('complete_delivery', async ({ riderId, orderId }) => {
      const id = cleanId(riderId || currentDriverId);
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
