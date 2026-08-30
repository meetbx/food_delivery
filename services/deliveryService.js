const axios = require('axios');
const { redis } = require('../db'); // Import the exported Redis instance from your db.js
const pool = require('../db');

const DRIVER_GEO_KEY = 'drivers:locations';

// In-memory cache for ETA calculations: "restaurantId-lat-lng" -> { etaText, timestamp }
const etaCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // Cache TTL: 10 minutes

/**
 * Updates or sets a driver's real-time coordinates in Redis Geo Index.
 * Note: Redis GEOADD takes coordinates in (Longitude, Latitude) order.
 */
async function updateDriverLocation(driverId, longitude, latitude) {
  if (!driverId || longitude === undefined || latitude === undefined) {
    throw new Error('driverId, longitude, and latitude are required');
  }

  const lng = parseFloat(longitude);
  const lat = parseFloat(latitude);

  if (isNaN(lng) || isNaN(lat)) {
    throw new Error('Invalid coordinates provided');
  }

  // GEOADD drivers:locations <longitude> <latitude> <driverId>
  await redis.geoadd(DRIVER_GEO_KEY, lng, lat, driverId.toString());
}

// REPLACE Lines 31-55 in deliveryService.js with this:

/**
 * Finds drivers near a specific location within a given radius (in km)
 * and filters out drivers who currently have active (undelivered) orders.
 */
async function findNearbyDrivers(longitude, latitude, radiusKm = 5) {
  const lng = parseFloat(longitude);
  const lat = parseFloat(latitude);

  if (isNaN(lng) || isNaN(lat)) {
    throw new Error('Invalid coordinates provided');
  }

  // Uses GEOSEARCH (Redis 6.2+)
  const nearbyDrivers = await redis.geosearch(
    DRIVER_GEO_KEY,
    'FROMLONLAT', lng, lat,
    'BYRADIUS', radiusKm, 'km',
    'WITHDIST',
    'ASC'
  );


  if (!nearbyDrivers || nearbyDrivers.length === 0) return [];

  // Extract raw driver IDs
  const candidateIds = nearbyDrivers.map(([driverId]) => {
    return parseInt(String(driverId).replace(/^(driver_|rider_)/, ''), 10);
  }).filter(id => !isNaN(id));

  if (candidateIds.length === 0) return [];

  // Query PostgreSQL: Filter out drivers who are already on active orders
  const activeRidersQuery = `
    SELECT DISTINCT rider_id 
    FROM orders 
    WHERE rider_id = ANY($1::int[]) 
      AND status NOT IN ('Delivered', 'Cancelled')
  `;
  const activeRes = await pool.query(activeRidersQuery, [candidateIds]);
  const busyRiderIds = new Set(activeRes.rows.map(r => r.rider_id));

  // Filter out busy drivers
  return nearbyDrivers
    .map(([driverId, distance]) => ({
      driverId: String(driverId).replace(/^(driver_|rider_)/, ''),
      distanceKm: parseFloat(distance)
    }))
    .filter(item => !busyRiderIds.has(parseInt(item.driverId, 10)));
    // Inside findNearbyDrivers(longitude, latitude, radiusKm)
console.log('  -> [GEOSEARCH LOG] Raw Redis drivers found:', nearbyDrivers);
console.log('  -> [BUSY CHECK] Busy Rider IDs in Postgres:', Array.from(busyRiderIds));
}
/**
 * Removes a driver from the Geo index when they go offline or stop accepting orders.
 */
async function removeDriverLocation(driverId) {
  if (!driverId) return;
  await redis.zrem(DRIVER_GEO_KEY, driverId.toString());
}

/**
 * Calculates estimated delivery time based on driving distance + base prep time.
 */
async function getEstimatedDeliveryTime(restaurantLat, restaurantLng, customerLat, customerLng, fallbackStaticTime) {
  // If customer or restaurant coordinates are missing, return static fallback
  if (!customerLat || !customerLng || !restaurantLat || !restaurantLng) {
    return fallbackStaticTime || '25-35 min';
  }

  const cLat = parseFloat(customerLat);
  const cLng = parseFloat(customerLng);
  const rLat = parseFloat(restaurantLat);
  const rLng = parseFloat(restaurantLng);

  if (isNaN(cLat) || isNaN(cLng) || isNaN(rLat) || isNaN(rLng)) {
    return fallbackStaticTime || '25-35 min';
  }

  // Cache Key rounded to 3 decimal places (~100m accuracy) to maximize cache hits
  const cacheKey = `${rLat.toFixed(3)},${rLng.toFixed(3)}-${cLat.toFixed(3)},${cLng.toFixed(3)}`;
  const cached = etaCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.etaText;
  }

  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.warn('GOOGLE_MAPS_API_KEY not set. Falling back to static delivery time.');
      return fallbackStaticTime || '25-35 min';
    }

    // Google Distance Matrix API endpoint
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${rLat},${rLng}&destinations=${cLat},${cLng}&mode=driving&key=${apiKey}`;
    const response = await axios.get(url);

    const data = response.data;
    if (
      data.status === 'OK' &&
      data.rows?.[0]?.elements?.[0]?.status === 'OK'
    ) {
      const element = data.rows[0].elements[0];
      const durationInSeconds = element.duration.value; // driving time in seconds
      const drivingMinutes = Math.ceil(durationInSeconds / 60);

      // Total Time = Kitchen Prep Time (~15 mins) + Buffer (~5 mins) + Driving Time
      const PREP_AND_BUFFER_TIME = 20;
      const minEta = drivingMinutes + PREP_AND_BUFFER_TIME;
      const maxEta = minEta + 10;
      const calculatedEta = `${minEta}-${maxEta} min`;

      // Store in Cache
      etaCache.set(cacheKey, { etaText: calculatedEta, timestamp: Date.now() });

      return calculatedEta;
    }
  } catch (err) {
    console.error('Distance Matrix API Error:', err.message);
  }

  return fallbackStaticTime || '25-35 min';
}

module.exports = {
  getEstimatedDeliveryTime,
  updateDriverLocation,
  findNearbyDrivers,
  removeDriverLocation
};
