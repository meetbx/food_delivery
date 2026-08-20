const { Server } = require('socket.io');
const { 
  updateDriverLocation, 
  removeDriverLocation 
} = require('./services/deliveryService');

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

    // 2. Register Rider / Driver into personal notification rooms
    socket.on('register_rider', ({ riderId, driverId }) => {
      const activeId = riderId || driverId;
      if (!activeId) return;

      const cleanId = String(activeId).replace(/^(driver_|rider_)/, '');
      currentDriverId = cleanId;

      // Associate driver ID with current active socket ID
      activeDriverSockets.set(cleanId, socket.id);

      // Join global active_riders room as well as specific rider/driver rooms
      socket.join('active_riders');
      socket.join(`driver_${cleanId}`);
      socket.join(`rider_${cleanId}`);

      console.log(`📡 Socket ${socket.id} registered for driver ${cleanId}`);
    });

    // 3. Receive live coordinates from Simulator or Rider App
    socket.on('send_rider_location', async (data) => {
      const { orderId, driverId, riderId, lat, lng, heading } = data;
      if (lat == null || lng == null) return;

      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (isNaN(latitude) || isNaN(longitude)) return;

      const targetDriverId = driverId || riderId || currentDriverId;
      if (targetDriverId) {
        const cleanId = String(targetDriverId).replace(/^(driver_|rider_)/, '');
        currentDriverId = cleanId;

        // Keep socket association active
        activeDriverSockets.set(cleanId, socket.id);

try {
  await updateDriverLocation(cleanId, longitude, latitude);
} catch (err) {
  console.error(`Error updating Redis location for driver ${cleanId}:`, err.message);
}

        // Emit location updates to the order room if active
        if (orderId) {
          io.to(`order_${orderId}`).emit('rider_location_updated', {
            orderId,
            driverId: cleanId,
            lat: latitude,
            lng: longitude,
            heading: heading || 0,
            timestamp: Date.now()
          });
        }

        // Broadcast location updates to driver specific rooms
        io.to(`rider_${cleanId}`).to(`driver_${cleanId}`).emit('driver_location_changed', {
          driverId: cleanId,
          lat: latitude,
          lng: longitude,
          heading: heading || 0
        });
      }
    });

    // 4. Express Rider Offline status explicitly
    socket.on('driver_offline', async ({ driverId, riderId }) => {
      const idToRemove = driverId || riderId || currentDriverId;
      if (idToRemove) {
        const cleanId = String(idToRemove).replace(/^(driver_|rider_)/, '');
        activeDriverSockets.delete(cleanId);
        try {
                  await removeDriverLocation(cleanId);
          console.log(`Driver ${cleanId} marked offline in Redis`);
        } catch (err) {
          console.error(`Error removing driver ${cleanId} from Redis:`, err.message);
        }
      }
    });

    // 5. Leave Order Room
    socket.on('leave_trial_room', ({ orderId }) => {
      const roomName = `order_${orderId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left room ${roomName}`);
    });

    // 6. Cleanup on Disconnect (Safe Grace Period)
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
      await removeDriverLocation(cleanId);
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
