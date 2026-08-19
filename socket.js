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

    // 2. Register Rider / Driver into personal notification rooms
    socket.on('register_rider', ({ riderId, driverId }) => {
      const activeId = riderId || driverId;
      if (!activeId) return;

      currentDriverId = activeId;
      
      // Clean prefix if passed in raw format
      const cleanId = String(activeId).replace(/^(driver_|rider_)/, '');

      // Join both room prefixes so backend emits to driver_X or rider_X always reach this socket
      socket.join(`driver_${cleanId}`);
      socket.join(`rider_${cleanId}`);

      console.log(`📡 Socket ${socket.id} joined rooms: driver_${cleanId} & rider_${cleanId}`);
    });

    // 3. Receive live coordinates from Simulator or Rider App
    socket.on('send_rider_location', async (data) => {
      const { orderId, driverId, riderId, lat, lng, heading } = data;
      if (lat == null || lng == null) return;

      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (isNaN(latitude) || isNaN(longitude)) return;

      // Track current driver associated with this socket instance
      const targetDriverId = driverId || riderId || currentDriverId;
      if (targetDriverId) {
        currentDriverId = targetDriverId;
      }

      // Update spatial index in Redis Geo (Longitude, Latitude)
      if (currentDriverId) {
        const cleanId = String(currentDriverId).replace(/^(driver_|rider_)/, '');
        try {
          // Sync both key formats in Redis Geo
          await updateDriverLocation(`driver_${cleanId}`, longitude, latitude);
          await updateDriverLocation(`rider_${cleanId}`, longitude, latitude);
        } catch (err) {
          console.error(`Error updating Redis location for driver ${currentDriverId}:`, err.message);
        }
      }

const rawDriverId = data.driverId || data.riderId || currentDriverId; 

if (rawDriverId) {
  // 2. Define cleanId safely
  const cleanId = String(rawDriverId).replace(/^(driver_|rider_)/, '');

  // 3. Emit location updates
  if (data.orderId) {
    io.to(`order_${data.orderId}`).emit('rider_location_updated', {
      orderId: data.orderId,
      driverId: cleanId,
      lat: data.lat || data.latitude,
      lng: data.lng || data.longitude,
      heading: data.heading || 0,
      timestamp: Date.now()
    });
  }

  // Broadcast to rider's specific rooms
  io.to(`rider_${cleanId}`).to(`driver_${cleanId}`).emit('driver_location_changed', {
    driverId: cleanId,
    lat: data.lat || data.latitude,
    lng: data.lng || data.longitude,
    heading: data.heading || 0
  });
}
    });

    // 4. Express Rider Offline status explicitly
    socket.on('driver_offline', async ({ driverId, riderId }) => {
      const idToRemove = driverId || riderId || currentDriverId;
      if (idToRemove) {
        const cleanId = String(idToRemove).replace(/^(driver_|rider_)/, '');
        try {
          await removeDriverLocation(`driver_${cleanId}`);
          await removeDriverLocation(`rider_${cleanId}`);
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

    // 6. Cleanup on Disconnect
    socket.on('disconnect', async () => {
      console.log(`[Socket Disconnected]: ${socket.id}`);
      
      // Optionally purge location from Redis if socket drops abruptly
      if (currentDriverId) {
        const cleanId = String(currentDriverId).replace(/^(driver_|rider_)/, '');
        try {
          await removeDriverLocation(`driver_${cleanId}`);
          await removeDriverLocation(`rider_${cleanId}`);
          console.log(`Removed disconnected driver ${cleanId} from Redis spatial index`);
        } catch (err) {
          console.error(`Failed cleanup for driver ${cleanId}:`, err.message);
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
