const { Server } = require('socket.io');
const {
  updateDriverLocation,
  removeDriverLocation
} = require('./services/deliveryService');

let io;

// riderId -> current socket.id
const activeDriverSockets = new Map();

const cleanRiderId = (value) => {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/^(driver_|rider_)/, '').trim();
  return /^\d+$/.test(cleaned) && Number(cleaned) > 0 ? cleaned : null;
};

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket) => {
    console.log(`[Socket Connected]: ${socket.id}`);

    let currentDriverId = null;

    socket.on('join_trial_room', ({ orderId } = {}) => {
      if (!orderId) return;
      const roomName = `order_${orderId}`;
      socket.join(roomName);
      console.log(`[ORDER ROOM] ${socket.id} -> ${roomName}`);
    });

    socket.on('register_rider', ({ riderId, driverId } = {}) => {
      const cleanId = cleanRiderId(riderId ?? driverId);

      if (!cleanId) {
        console.warn(`[REGISTER SKIP] Invalid rider ID from socket ${socket.id}:`, { riderId, driverId });
        return;
      }

      currentDriverId = cleanId;

      // If this rider already has another socket, remove that socket's personal
      // rooms. This guarantees one active notification connection per rider.
      const previousSocketId = activeDriverSockets.get(cleanId);
      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          previousSocket.leave(`active_riders`);
          previousSocket.leave(`driver_${cleanId}`);
          previousSocket.leave(`rider_${cleanId}`);
          previousSocket.emit('duplicate_rider_connection', { riderId: Number(cleanId) });
          console.log(`[SOCKET REPLACED] Rider ${cleanId}: ${previousSocketId} -> ${socket.id}`);
        }
      }

      activeDriverSockets.set(cleanId, socket.id);
      socket.join('active_riders');
      socket.join(`driver_${cleanId}`);
      socket.join(`rider_${cleanId}`);

      console.log(`[REGISTER] Socket ${socket.id} registered rider ${cleanId}`);
      console.log(`[ROOMS]`, Array.from(socket.rooms));
    });

    socket.on('send_rider_location', async (data = {}) => {
      const targetDriverId = cleanRiderId(data.driverId ?? data.riderId ?? currentDriverId);
      const lat = parseFloat(data.lat);
      const lng = parseFloat(data.lng);

      if (!targetDriverId) {
        console.warn(`[LOCATION SKIP] Socket ${socket.id} has no valid rider ID`);
        return;
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.warn(`[LOCATION SKIP] Invalid coordinates from rider ${targetDriverId}`);
        return;
      }

      try {
        await updateDriverLocation(targetDriverId, lng, lat);
      } catch (err) {
        console.error(`[REDIS ERROR] Driver ${targetDriverId}:`, err.message);
      }
    });

    socket.on('driver_offline', async ({ driverId, riderId } = {}) => {
      const cleanId = cleanRiderId(driverId ?? riderId ?? currentDriverId);
      if (!cleanId) return;

      if (activeDriverSockets.get(cleanId) === socket.id) {
        activeDriverSockets.delete(cleanId);
      }

      try {
        await removeDriverLocation(`driver_${cleanId}`);
        await removeDriverLocation(`rider_${cleanId}`);
      } catch (err) {
        console.error(`[OFFLINE ERROR] Rider ${cleanId}:`, err.message);
      }
    });

    socket.on('leave_trial_room', ({ orderId } = {}) => {
      if (!orderId) return;
      socket.leave(`order_${orderId}`);
    });

    socket.on('disconnect', async (reason) => {
      console.log(`[Socket Disconnected]: ${socket.id} | ${reason}`);

      if (!currentDriverId) return;

      const cleanId = currentDriverId;
      const disconnectedSocketId = socket.id;

      // Do not remove the rider from Redis if a new socket has already replaced it.
      setTimeout(async () => {
        if (activeDriverSockets.get(cleanId) !== disconnectedSocketId) {
          return;
        }

        activeDriverSockets.delete(cleanId);

        try {
          await removeDriverLocation(`driver_${cleanId}`);
          await removeDriverLocation(`rider_${cleanId}`);
          console.log(`[REDIS CLEANUP] Rider ${cleanId} removed after disconnect`);
        } catch (err) {
          console.error(`[REDIS CLEANUP ERROR] Rider ${cleanId}:`, err.message);
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

module.exports = { initSocket, getIo };
