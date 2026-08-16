const { Server } = require('socket.io');
const { 
  updateDriverLocation, 
  removeDriverLocation 
} = require('./services/deliveryService');

let io;

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

    // 2. Receive live coordinates from Simulator or Rider App
    socket.on('send_rider_location', async (data) => {
      const { orderId, driverId, lat, lng, heading } = data;
      if (lat == null || lng == null) return;

      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (isNaN(latitude) || isNaN(longitude)) return;

      // Track current driver associated with this socket instance
      if (driverId) {
        currentDriverId = driverId;
      }

      // Update spatial index in Redis Geo (Longitude, Latitude)
      if (currentDriverId) {
        try {
          await updateDriverLocation(currentDriverId, longitude, latitude);
        } catch (err) {
          console.error(`Error updating Redis location for driver ${currentDriverId}:`, err.message);
        }
      }

      // Broadcast live coordinates to all clients listening in order_<orderId>
      if (orderId) {
        const roomName = `order_${orderId}`;
        io.to(roomName).emit('rider_location_updated', {
          orderId,
          driverId: currentDriverId,
          lat: latitude,
          lng: longitude,
          heading: heading || 0,
          timestamp: Date.now(),
        });
      }
    });

    // 3. Express Rider Offline status explicitly
    socket.on('driver_offline', async ({ driverId }) => {
      const idToRemove = driverId || currentDriverId;
      if (idToRemove) {
        try {
          await removeDriverLocation(idToRemove);
          console.log(`Driver ${idToRemove} marked offline in Redis`);
        } catch (err) {
          console.error(`Error removing driver ${idToRemove} from Redis:`, err.message);
        }
      }
    });

    // 4. Leave Order Room
    socket.on('leave_trial_room', ({ orderId }) => {
      const roomName = `order_${orderId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left room ${roomName}`);
    });

    // 5. Cleanup on Disconnect
    socket.on('disconnect', async () => {
      console.log(`[Socket Disconnected]: ${socket.id}`);
      
      // Optionally purge location from Redis if socket drops abruptly
      if (currentDriverId) {
        try {
          await removeDriverLocation(currentDriverId);
          console.log(`Removed disconnected driver ${currentDriverId} from Redis spatial index`);
        } catch (err) {
          console.error(`Failed cleanup for driver ${currentDriverId}:`, err.message);
        }
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
