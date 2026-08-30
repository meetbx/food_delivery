const { Server } = require('socket.io');
const { 
  updateDriverLocation, 
  removeDriverLocation 
} = require('./services/deliveryService');
const { pool } = require('./db');

let io;

// Active tracking map: driverId -> current socket.id
const activeDriverSockets = new Map();

/**
 * Initializes Socket.IO on the HTTP server
 * @param {Object} server - Node.js HTTP Server instance
 */
const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: '*', // Allows local testing across frontend ports (e.g. 5173 / 3000)
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log(`[Socket Connected]: ${socket.id}`);

    // Map to track active driver ID associated with this socket connection
    let currentDriverId = null;

    // 1. Join Order Room for trial/order tracking
    socket.on('join_trial_room', ({ orderId }) => {
      if (!orderId) return;
      const roomName = `order_${orderId}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} joined room ${roomName}`);
    });

    // 2. Register Rider / Driver into personal notification rooms & sync state
    socket.on('register_rider', async (data) => {
      const activeId = typeof data === 'object' ? (data.riderId || data.driverId) : data;
      if (!activeId) return;

      const cleanId = String(activeId).replace(/^(driver_|rider_)/, '');
      const numericId = parseInt(cleanId, 10);
      currentDriverId = cleanId;

      activeDriverSockets.set(cleanId, socket.id);

      socket.join('active_riders');
      socket.join(`driver_${cleanId}`);
      socket.join(`rider_${cleanId}`);

      console.log(`[REGISTER DEBUG] Socket ${socket.id} joined rooms: driver_${cleanId}, rider_${cleanId}`);

      // Active Delivery Sync: Check if rider is currently executing an active order
      if (!isNaN(numericId)) {
        try {
          const activeOrderRes = await pool.query(
            `SELECT * FROM orders WHERE rider_id = $1 AND status NOT IN ('Delivered', 'Cancelled') LIMIT 1`,
            [numericId]
          );

          if (activeOrderRes.rows.length > 0) {
            socket.emit('active_order_sync', activeOrderRes.rows[0]);
          }
        } catch (syncErr) {
          console.error(`[SYNC ERROR] Rider ${cleanId}:`, syncErr.message);
        }
      }
    });

    // 3. Receive live coordinates from Simulator or Rider App
    socket.on('send_rider_location', async (data) => {
      const { driverId, riderId, lat, lng } = data;
      const targetDriverId = driverId || riderId || currentDriverId;
      const cleanId = String(targetDriverId).replace(/^(driver_|rider_)/, '');

      console.log(`[LOCATION INCOMING] Driver ${cleanId} sent coords -> Lat: ${lat}, Lng: ${lng}`);

      try {
        await updateDriverLocation(cleanId, parseFloat(lng), parseFloat(lat));
        console.log(`[REDIS SUCCESS] Driver ${cleanId} location updated in Redis spatial index.`);
      } catch (err) {
        console.error(`[REDIS ERROR] Failed to update location for Driver ${cleanId}:`, err.message);
      }
    });

    // 4. Handle Rider Order Acceptance via WebSockets
    socket.on('accept_order', async (data) => {
      console.log('📥 [SOCKET ACCEPT] Received accept_order payload:', data);
      const { orderId, riderId, driverId } = data || {};
      const activeRiderId = riderId || driverId;

      if (!orderId || !activeRiderId) {
        return socket.emit('order_accept_error', { message: 'Missing orderId or riderId' });
      }

      const cleanRiderId = parseInt(String(activeRiderId).replace(/^(driver_|rider_)/, ''), 10);

      try {
        // Atomic DB Update: Assign order ONLY if status is still Pending
// Replace the UPDATE query inside accept_order:
const updateRes = await pool.query(
  `UPDATE orders 
   SET rider_id = $1, status = 'Accepted' 
   WHERE id = $2 
     AND (status IN ('Pending', 'Placed', 'Paid', 'Created') OR status IS NULL)
     AND (rider_id IS NULL OR rider_id = $1)
   RETURNING *`,
  [cleanRiderId, orderId]
);

        if (updateRes.rows.length === 0) {
          console.warn(`⚠️ Order ${orderId} already taken or not pending.`);
          return socket.emit('order_accept_error', { 
            message: 'Order was already accepted by another rider or cancelled.' 
          });
        }

        const updatedOrder = updateRes.rows[0];

        // Clear pending offer statuses in tracking matrix
        await pool.query(
          `UPDATE order_rider_offers SET status = 'accepted', responded_at = NOW() WHERE order_id = $1 AND rider_id = $2`,
          [orderId, cleanRiderId]
        ).catch(() => {});

        // Confirm acceptance back to the rider
        socket.emit('order_accepted_success', updatedOrder);

        // Broadcast live status update to customer tracking room
        io.to(`order_${orderId}`).emit('order_status_update', updatedOrder);
        
        console.log(`✅ Order ${orderId} successfully assigned to Rider ${cleanRiderId}`);
      } catch (err) {
        console.error('Error in accept_order socket handler:', err.message);
        socket.emit('order_accept_error', { message: 'Server error accepting order' });
      }
    });

    // 5. Express Rider Offline status explicitly
    socket.on('driver_offline', async ({ driverId, riderId }) => {
      const idToRemove = driverId || riderId || currentDriverId;
      if (idToRemove) {
        const cleanId = String(idToRemove).replace(/^(driver_|rider_)/, '');
        activeDriverSockets.delete(cleanId);
        try {
          await removeDriverLocation(`driver_${cleanId}`);
          await removeDriverLocation(`rider_${cleanId}`);
          console.log(`Driver ${cleanId} marked offline in Redis`);
        } catch (err) {
          console.error(`Error removing driver ${cleanId} from Redis:`, err.message);
        }
      }
    });

    // 6. Leave Order Room
    socket.on('leave_trial_room', ({ orderId }) => {
      const roomName = `order_${orderId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left room ${roomName}`);
    });

    // 7. Cleanup on Disconnect (Safe Grace Period)
    socket.on('disconnect', async () => {
      console.log(`[Socket Disconnected]: ${socket.id}`);

      if (currentDriverId) {
        const cleanId = String(currentDriverId).replace(/^(driver_|rider_)/, '');
        const disconnectedSocketId = socket.id;

        // Grace period: Wait 5 seconds before removing from Redis
        setTimeout(async () => {
          // CRITICAL FIX: Only remove if driver HAS NOT reconnected with a new socket
          if (activeDriverSockets.get(cleanId) === disconnectedSocketId) {
            activeDriverSockets.delete(cleanId);
            try {
              await removeDriverLocation(`driver_${cleanId}`);
              await removeDriverLocation(`rider_${cleanId}`);
              console.log(`Removed disconnected driver ${cleanId} from Redis spatial index`);
            } catch (err) {
              console.error(`Failed cleanup for driver ${cleanId}:`, err.message);
            }
          } else {
            console.log(`Driver ${cleanId} reconnected on a new socket. Preserved in Redis.`);
          }
        }, 5000);
      }
    });
  });

  return io;
};

/**
 * Getter to access the initialized Socket.IO instance elsewhere in the backend
 */
const getIo = () => {
  if (!io) {
    throw new Error('Socket.io has not been initialized!');
  }
  return io;
};

module.exports = { initSocket, getIo };
