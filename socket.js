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
  const order = await getOrderRestaurant(orderId);
  if (!order || ['Accepted', 'Picked Up', 'Delivered', 'Cancelled'].includes(order.status)) return null;

  const restLat = parseFloat(order.restaurant_latitude);
  const restLng = parseFloat(order.restaurant_longitude);
  if (isNaN(restLat) || isNaN(restLng)) return null;

  const excluded = new Set(excludedRiderIds.map(id => cleanId(id)));
  if (order.rider_id) excluded.add(cleanId(order.rider_id));

  // Never offer again to a rider who already declined/expired this order.
  const priorOffers = await pool.query(`
    SELECT rider_id
    FROM order_rider_offers
    WHERE order_id = $1
      AND status IN ('declined', 'expired', 'accepted')
  `, [orderId]);
  priorOffers.rows.forEach(row => excluded.add(cleanId(row.rider_id)));

  const searchRadiusKm = parseFloat(process.env.RIDER_SEARCH_RADIUS_KM || '10');
  const nearby = await findNearbyDrivers(restLng, restLat, searchRadiusKm);

  for (const candidate of nearby) {
    const riderId = cleanId(candidate.driverId);
    if (!riderId || excluded.has(riderId)) continue;

    // Only offer to an online rider with a connected socket.
    if (!activeDriverSockets.has(riderId)) continue;

    const riderResult = await pool.query(`
      SELECT r.id, r.name, r.last_latitude, r.last_longitude
      FROM riders r
      WHERE r.id = $1
        AND r.is_online = true
        AND NOT EXISTS (
          SELECT 1
          FROM orders ao
          WHERE ao.rider_id = r.id
            AND ao.status IN ('Accepted', 'Picked Up', 'Out for Delivery')
        )
    `, [riderId]);
    if (!riderResult.rows.length) continue;

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
      riderLocation: {
        lat: parseFloat(riderResult.rows[0].last_latitude),
        lng: parseFloat(riderResult.rows[0].last_longitude)
      }
    };

    io.to(`driver_${riderId}`).emit('new_order_offer', payload);
    io.to(`rider_${riderId}`).emit('new_order_offer', payload);
    console.log(`[DISPATCH] Order ${orderId} offered to rider ${riderId} (${candidate.distanceKm} km)`);
    return riderId;
  }

  console.log(`[DISPATCH] No eligible rider found for order ${orderId}`);
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

    socket.on('register_rider', ({ riderId, driverId }) => {
      const id = cleanId(riderId || driverId);
      if (!id) return;
      currentDriverId = id;
      activeDriverSockets.set(id, socket.id);
      pool.query('UPDATE riders SET is_online = true WHERE id = $1', [id]).catch(err =>
        console.error('[ONLINE STATUS ERROR]', err.message)
      );
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

        // First rider to accept wins.
        const orderResult = await client.query(`
          SELECT id, status, rider_id
          FROM orders
          WHERE id = $1
          FOR UPDATE
        `, [orderId]);

        if (!orderResult.rows.length) throw new Error('Order not found');
        const order = orderResult.rows[0];

        // A rider can only have one active delivery at a time. This is a
        // backend safety check in addition to the dashboard UI guard.
        const activeDeliveryResult = await client.query(`
          SELECT id
          FROM orders
          WHERE rider_id = $1
            AND status IN ('Accepted', 'Picked Up', 'Out for Delivery')
          LIMIT 1
        `, [id]);
        if (activeDeliveryResult.rows.length) {
          await client.query('ROLLBACK');
          socket.emit('order_accept_failed', {
            orderId,
            message: 'You already have an active delivery.'
          });
          return;
        }

        if (order.rider_id || order.status !== 'Pending') {
          await client.query('ROLLBACK');
          socket.emit('order_accept_failed', { orderId, message: 'Order is no longer available.' });
          return;
        }

        const riderResult = await client.query(`
          SELECT id, name, last_latitude, last_longitude
          FROM riders
          WHERE id = $1 AND is_online = true
        `, [id]);

        if (!riderResult.rows.length) throw new Error('Rider is offline or not found');

        await client.query(`
          UPDATE orders
          SET rider_id = $1, status = 'Accepted'
          WHERE id = $2
        `, [id, orderId]);

        await client.query(`
          INSERT INTO order_rider_offers (order_id, rider_id, status, responded_at)
          VALUES ($1, $2, 'accepted', NOW())
          ON CONFLICT (order_id, rider_id)
          DO UPDATE SET status = 'accepted', responded_at = NOW()
        `, [orderId, id]);

        await client.query(`
          UPDATE order_rider_offers
          SET status = 'expired', responded_at = NOW()
          WHERE order_id = $1 AND rider_id <> $2 AND status = 'offered'
        `, [orderId, id]);

        await client.query('COMMIT');

        const rider = riderResult.rows[0];
        const riderLocation = {
          lat: parseFloat(rider.last_latitude),
          lng: parseFloat(rider.last_longitude)
        };

        io.to(`order_${orderId}`).emit('order_accepted', {
          orderId: Number(orderId),
          riderId: Number(id),
          riderLocation: Number.isFinite(riderLocation.lat) && Number.isFinite(riderLocation.lng)
            ? riderLocation : null
        });

        // Tell all other riders who received this offer to remove it.
        io.emit('order_taken', { orderId: Number(orderId), riderId: Number(id) });
        socket.emit('order_accept_success', { orderId: Number(orderId) });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[ACCEPT ORDER ERROR]', err.message);
        socket.emit('order_accept_failed', { orderId, message: err.message });
      } finally {
        client.release();
      }
    });

    socket.on('decline_order', async ({ orderId, riderId, driverId }) => {
      const id = cleanId(riderId || driverId || currentDriverId);
      if (!orderId || !id) return;

      try {
        await pool.query(`
          INSERT INTO order_rider_offers (order_id, rider_id, status, responded_at)
          VALUES ($1, $2, 'declined', NOW())
          ON CONFLICT (order_id, rider_id)
          DO UPDATE SET status = 'declined', responded_at = NOW()
        `, [orderId, id]);

        const nextRiderId = await dispatchNextRider(orderId, [id]);
        socket.emit('order_declined', {
          orderId: Number(orderId),
          nextRiderId: nextRiderId ? Number(nextRiderId) : null
        });
      } catch (err) {
        console.error('[DECLINE ORDER ERROR]', err.message);
      }
    });

    socket.on('leave_order_room', ({ orderId }) => {
      if (orderId) socket.leave(`order_${orderId}`);
    });
    socket.on('leave_trial_room', ({ orderId }) => {
      if (orderId) socket.leave(`order_${orderId}`);
    });

    socket.on('driver_offline', async ({ driverId, riderId } = {}) => {
      const id = cleanId(driverId || riderId || currentDriverId);
      if (!id) return;
      activeDriverSockets.delete(id);
      try {
        await removeDriverLocation(id);
        await pool.query('UPDATE riders SET is_online = false WHERE id = $1', [id]);
      } catch (err) {
        console.error('[OFFLINE ERROR]', err.message);
      }
    });

    socket.on('disconnect', () => {
      if (!currentDriverId) return;
      const id = currentDriverId;
      const disconnectedSocketId = socket.id;
      setTimeout(async () => {
        if (activeDriverSockets.get(id) !== disconnectedSocketId) return;
        activeDriverSockets.delete(id);
        try {
          await removeDriverLocation(id);
        } catch (err) {
          console.error('[DISCONNECT CLEANUP]', err.message);
        }
      }, 5000);
    });
  });

  return io;
};

const getIo = () => {
  if (!io) throw new Error('Socket.io has not been initialized!');
  return io;
};

module.exports = { initSocket, getIo, dispatchNextRider };
