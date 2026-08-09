const { Server } = require('socket.io');

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

    // 1. Join Order Room for trial tracking
    socket.on('join_trial_room', ({ orderId }) => {
      if (!orderId) return;
      const roomName = `order_${orderId}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} joined room ${roomName}`);
    });

    // 2. Receive live coordinates from Simulator or Rider App
    socket.on('send_rider_location', ({ orderId, lat, lng, heading }) => {
      if (!orderId || lat == null || lng == null) return;

      const roomName = `order_${orderId}`;

      // Broadcast live coordinates to all clients listening in order_<orderId>
      io.to(roomName).emit('rider_location_updated', {
        orderId,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        heading: heading || 0,
        timestamp: Date.now(),
      });
    });

    // 3. Leave Order Room
    socket.on('leave_trial_room', ({ orderId }) => {
      const roomName = `order_${orderId}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left room ${roomName}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected]: ${socket.id}`);
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