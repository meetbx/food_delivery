const express = require('express');
const cors = require('cors');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const pool = require('./db');
// Import delivery ETA helper service
const { getEstimatedDeliveryTime } = require('./services/deliveryService');
const trialOrderRouter = require('./routes/trialOrder');
const http = require('http');
const { initSocket } = require('./socket');
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || '4a89f2c38b1e8f9076543210abcd1234ef567890abcdef1234567890abcdef12';

const riderAuthRoutes = require('./routes/riderAuth');
const userAuthRoutes = require('./routes/userAuth');
const addressRoutes = require('./routes/addressRoutes');




// 2. Middleware
// ✅ Updated CORS configuration allowing Vercel deployment & localhost
const allowedOrigins = [
  'https://food-front-delivery-245r-mu.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. mobile apps, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// Add route handlers
app.use('/api/auth', userAuthRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/rider', riderAuthRoutes);
app.use('/api', trialOrderRouter);
initSocket(server);
// Health Check
app.get('/', (req, res) => {
  res.send('API Server Running Successfully');
});
router.get('/eta', async (req, res) => {
  try {
    const { restaurantLat, restaurantLng, customerLat, customerLng, fallback } = req.query;

    const eta = await getEstimatedDeliveryTime(
      restaurantLat,
      restaurantLng,
      customerLat,
      customerLng,
      fallback
    );

    res.json({ eta });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate delivery time' });
  }
});

module.exports = router;
// -------------------------------------------------------------
// RESTAURANT FETCH ROUTES (WITH DYNAMIC ETA CALCULATION)
// -------------------------------------------------------------

// GET /api/restaurants
app.get('/api/restaurants', async (req, res) => {
  try {
    const { city, category, cuisine, search, q, address_id, lat, lng } = req.query;
   
    let userLat = null;
    let userLng = null;

    // 1. Fetch lat/lng from addresses table FIRST if address_id is provided
    if (address_id) {
      const addressRes = await pool.query(
        'SELECT latitude, longitude FROM addresses WHERE id = $1',
        [address_id]
      );
      if (addressRes.rows.length > 0) {
        const { latitude, longitude } = addressRes.rows[0];
        if (latitude !== null && longitude !== null && !isNaN(parseFloat(latitude)) && !isNaN(parseFloat(longitude))) {
          userLat = parseFloat(latitude);
          userLng = parseFloat(longitude);
        }
      }
    }

    // 2. Fall back to raw GPS parameters only if no address_id was matched/provided
    if (userLat === null && userLng === null) {
      userLat = (lat && !isNaN(parseFloat(lat))) ? parseFloat(lat) : null;
      userLng = (lng && !isNaN(parseFloat(lng))) ? parseFloat(lng) : null;
    }

    // Pick whichever filter parameter the frontend sends
    const filterText = category || cuisine || search || q;

    let conditions = [];
    let params = [];

    // Filter by City (if provided)
    if (city && city.trim() !== '') {
      params.push(city.trim());
      conditions.push(`LOWER(city) = LOWER($${params.length})`);
    }

    // Filter by Category / Cuisine / Search Term (if provided)
    if (filterText && filterText.trim() !== '') {
      const cleanFilter = filterText.trim().replace(/(?<!s)s$/i, '');
      params.push(`%${cleanFilter}%`);
      
      conditions.push(`(cuisine_type ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }

    // Build the SQL query dynamically
    let queryText = 'SELECT * FROM restaurants';
    if (conditions.length > 0) {
      queryText += ' WHERE ' + conditions.join(' AND ');
    }
    queryText += ' ORDER BY id DESC;';

    let result = await pool.query(queryText, params);

    // Fallback: If searching with a city returned 0 rows, attempt fallback
    if (result.rows.length === 0 && city) {
      let fallbackParams = [];
      let fallbackConditions = [];

      if (filterText && filterText.trim() !== '') {
        const cleanFilter = filterText.trim().replace(/(?<!s)s$/i, '');
        fallbackParams.push(`%${cleanFilter}%`);
        fallbackConditions.push(`(cuisine_type ILIKE $1 OR name ILIKE $1)`);
      }

      let fallbackQuery = 'SELECT * FROM restaurants';
      if (fallbackConditions.length > 0) {
        fallbackQuery += ' WHERE ' + fallbackConditions.join(' AND ');
      }
      fallbackQuery += ' ORDER BY id DESC;';

      result = await pool.query(fallbackQuery, fallbackParams);
    }

    // Calculate dynamic delivery time safely
    const restaurantsWithEta = await Promise.all(
      result.rows.map(async (rest) => {
        let dynamicEta = rest.delivery_time || '25-35 mins';

        // Only calculate distance/ETA if we have valid customer coordinates and restaurant coordinates
        if (userLat !== null && userLng !== null && rest.latitude !== null && rest.longitude !== null) {
          try {
            const calculatedEta = await getEstimatedDeliveryTime(
              parseFloat(rest.latitude),
              parseFloat(rest.longitude),
              userLat,
              userLng,
              rest.delivery_time
            );
            if (calculatedEta) {
              dynamicEta = calculatedEta;
            }
          } catch (calcError) {
            console.error(`[ETA ERROR] Failed to calculate ETA for rest ID ${rest.id}:`, calcError);
            // Fallback to static delivery_time if distance calculation fails
            dynamicEta = rest.delivery_time || '25-35 mins';
          }
        }

        return {
          ...rest,
          delivery_time: dynamicEta
        };
      })
    );

    res.json(restaurantsWithEta);
  } catch (err) {
    console.error('Error fetching restaurants:', err);
    res.status(500).json({ error: 'Server error fetching restaurants' });
  }
});
// GET /api/restaurants/:id
app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng } = req.query;

    // Fetch restaurant and menu items concurrently
    const [restaurantRes, menuRes] = await Promise.all([
      pool.query('SELECT * FROM restaurants WHERE id = $1', [id]),
      pool.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY id ASC', [id])
    ]);

    if (restaurantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantRes.rows[0];

    // Calculate dynamic ETA concurrently or sequentially after getting coordinates
    const dynamicEta = await getEstimatedDeliveryTime(
      restaurant.latitude,
      restaurant.longitude,
      lat ? parseFloat(lat) : null,
      lng ? parseFloat(lng) : null,
      restaurant.delivery_time
    );

    res.json({
      restaurant: {
        ...restaurant,
        delivery_time: dynamicEta
      },
      menu: menuRes.rows
    });
  } catch (err) {
    console.error('Error fetching restaurant detail:', err);
    res.status(500).json({ error: 'Server error fetching restaurant menu' });
  }
});

// -------------------------------------------------------------
// SEARCH & CATEGORY FILTER ROUTES
// -------------------------------------------------------------

// 1. GET /api/categories/:categoryName/restaurants
app.get('/api/categories/:categoryName/restaurants', async (req, res) => {
  try {
    const { categoryName } = req.params;

    const query = `
      SELECT DISTINCT r.id, r.name, r.cuisine_type, r.address, r.city, r.rating, r.image_url, r.delivery_time, r.latitude, r.longitude
      FROM restaurants r
      JOIN menu_items m ON r.id = m.restaurant_id
      WHERE LOWER(m.category) = LOWER($1) 
        AND r.is_active = TRUE 
        AND m.is_available = TRUE
      ORDER BY r.rating DESC;
    `;

    const result = await pool.query(query, [categoryName.trim()]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching category restaurants:', err);
    res.status(500).json({ error: 'Server error fetching category restaurants' });
  }
});

// 2. GET /api/search?q=pizza
app.get('/api/search', async (req, res) => {
  try {
    const searchTerm = req.query.q;

    if (!searchTerm || searchTerm.trim() === '') {
      return res.json([]);
    }

    const query = `
      SELECT 
        r.id AS restaurant_id,
        r.name AS restaurant_name,
        r.cuisine_type,
        r.address,
        r.city,
        r.rating,
        r.image_url AS restaurant_image,
        r.delivery_time,
        r.latitude,
        r.longitude,
        json_agg(
          json_build_object(
            'id', m.id,
            'name', m.name,
            'price', m.price,
            'description', m.description,
            'category', m.category,
            'is_veg', m.is_veg,
            'image_url', m.image_url
          )
        ) AS matching_dishes
      FROM restaurants r
      JOIN menu_items m ON r.id = m.restaurant_id
      WHERE (
        LOWER(m.name) LIKE LOWER($1)
        OR LOWER(m.description) LIKE LOWER($1)
        OR LOWER(m.category) LIKE LOWER($1)
        OR LOWER(r.name) LIKE LOWER($1)
        OR LOWER(r.cuisine_type) LIKE LOWER($1)
      )
      AND r.is_active = TRUE 
      AND m.is_available = TRUE
      GROUP BY r.id, r.name, r.cuisine_type, r.address, r.city, r.rating, r.image_url, r.delivery_time, r.latitude, r.longitude
      ORDER BY r.rating DESC;
    `;

    const searchPattern = `%${searchTerm.trim()}%`;
    const result = await pool.query(query, [searchPattern]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error executing search query:', err);
    res.status(500).json({ error: 'Server error executing search' });
  }
});

// -------------------------------------------------------------
// ADD / CREATE NEW RESTAURANT ROUTE
// -------------------------------------------------------------

app.post('/api/admin/restaurants', async (req, res) => {
  try {
    const {
      name,
      city,
      address,
      cuisine,
      cuisine_type,
      rating,
      delivery_time,
      image_url,
      is_open
    } = req.body;

    if (!name || !city) {
      return res.status(400).json({ message: 'Restaurant name and city are required.' });
    }

    const queryText = `
      INSERT INTO restaurants (
        name,
        city,
        address,
        cuisine_type,
        rating,
        delivery_time,
        image_url,
        is_open
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      name,
      city.trim(),
      address || '',
      cuisine_type || cuisine || 'Multi-Cuisine',
      Number(rating || 4.2),
      delivery_time || '25-35 mins',
      image_url || 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4',
      is_open !== undefined ? is_open : true
    ];

    const result = await pool.query(queryText, values);
    res.status(201).json({
      message: 'Restaurant created successfully!',
      restaurant: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Error adding restaurant:', error);
    res.status(500).json({ message: error.message || 'Server error creating restaurant' });
  }
});

// Alias for standard route
app.post('/api/restaurants', (req, res) => app._router.handle(req, res));

// -------------------------------------------------------------
// ADD MENU ITEM / DISH ROUTES
// -------------------------------------------------------------

const addMenuItem = async (req, res) => {
  try {
    const restaurantId = req.params.id || req.body.restaurant_id;
    const {
      name,
      description,
      price,
      category,
      image_url,
      is_veg
    } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant ID is required.' });
    }

    if (!name || price === undefined) {
      return res.status(400).json({ message: 'Dish name and price are required.' });
    }

    const queryText = `
      INSERT INTO menu_items (
        restaurant_id,
        name,
        description,
        price,
        category,
        image_url,
        is_veg
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const values = [
      Number(restaurantId),
      name,
      description || '',
      Number(price),
      category || 'Main Course',
      image_url || '',
      is_veg === true || is_veg === 'true'
    ];

    const result = await pool.query(queryText, values);

    res.status(201).json({
      message: 'Dish added successfully!',
      dish: result.rows[0],
      menu_item: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Error adding menu item:', error);
    res.status(500).json({ message: error.message || 'Server error adding menu item' });
  }
};

app.post('/api/admin/restaurants/:id/menu', addMenuItem);
app.post('/api/restaurants/:id/menu', addMenuItem);
app.post('/api/menu-items', addMenuItem);

// DELETE /api/menu-items/:id
app.delete('/api/menu-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM menu_items WHERE id = $1 RETURNING *;', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dish not found' });
    }

    res.json({ message: 'Dish deleted successfully', dish: result.rows[0] });
  } catch (error) {
    console.error('Error deleting dish:', error);
    res.status(500).json({ message: 'Server error deleting dish' });
  }
});

// PUT /api/menu-items/:id (Update Dish Details in PostgreSQL)
app.put('/api/menu-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, description, price, is_veg, image_url } = req.body;

    const query = `
      UPDATE menu_items 
      SET 
        name = COALESCE($1, name),
        category = COALESCE($2, category),
        description = COALESCE($3, description),
        price = COALESCE($4, price),
        is_veg = COALESCE($5, is_veg),
        image_url = COALESCE($6, image_url)
      WHERE id = $7
      RETURNING *;
    `;

    const values = [
      name || null,
      category || null,
      description || null,
      price ? parseFloat(price) : null,
      is_veg ?? null,
      image_url || null,
      id
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Dish item not found in database' });
    }

    res.json({
      message: 'Dish updated successfully!',
      item: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating dish item:', err);
    res.status(500).json({ message: 'Server error updating dish item' });
  }
});

// -------------------------------------------------------------
// ORDERS & CHECKOUT ROUTES
// -------------------------------------------------------------

// POST /api/orders (Place Order Endpoint)
app.post('/api/orders', async (req, res) => {
  try {
    const {
      user_id,
      userId,
      address_id,
      addressId,
      selectedAddressId,
      restaurant_id,
      delivery_address,
      payment_method,
      payment_status,
      item_total,
      tax,
      delivery_fee,
      discount,
      final_total,
      total_amount,
      items,
      cart
    } = req.body;

    // 1. Resolve User ID (accepts user_id or userId)
    const activeUserId = user_id || userId || null;

    // 2. Resolve Address ID (accepts address_id, addressId, or selectedAddressId)
    const activeAddressId = address_id || addressId || selectedAddressId || null;

    let fetchedAddress = null;
    let fetchedLat = null;
    let fetchedLng = null;

    // 3. Fetch address details from DB if address_id exists
    if (activeAddressId) {
      try {
        const addressRes = await pool.query(
          `SELECT full_address, latitude, longitude FROM addresses WHERE id = $1`,
          [activeAddressId]
        );
        if (addressRes.rows.length > 0) {
          fetchedAddress = addressRes.rows[0].full_address;
          fetchedLat = addressRes.rows[0].latitude;
          fetchedLng = addressRes.rows[0].longitude;
        }
      } catch (addrErr) {
        console.warn('⚠️ Could not fetch details from addresses table:', addrErr.message);
      }
    } 
    // Fallback: If no address_id was sent, attempt to fetch the user's default address using activeUserId
    else if (activeUserId) {
      try {
        const defaultAddrRes = await pool.query(
          `SELECT full_address, latitude, longitude FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, id DESC LIMIT 1`,
          [activeUserId]
        );
        if (defaultAddrRes.rows.length > 0) {
          fetchedAddress = defaultAddrRes.rows[0].full_address;
          fetchedLat = defaultAddrRes.rows[0].latitude;
          fetchedLng = defaultAddrRes.rows[0].longitude;
        }
      } catch (err) {
        console.warn('⚠️ Could not fetch default address:', err.message);
      }
    }

    let rawItems = items || cart || [];
    if (typeof rawItems === 'string') {
      try {
        rawItems = JSON.parse(rawItems);
      } catch (e) {
        rawItems = [];
      }
    }

    const itemsJson = JSON.stringify(rawItems);
    const calcTotal = Number(final_total || total_amount || item_total || 0);

    // 4. Save to orders table
    const orderQuery = `
      INSERT INTO orders (
        user_id,
        restaurant_id,
        delivery_address,
        delivery_latitude,
        delivery_longitude,
        items, 
        item_total, 
        tax, 
        delivery_fee,
        discount,
        final_total, 
        status, 
        payment_status,
        payment_method
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;

    const orderValues = [
      activeUserId ? Number(activeUserId) : null,                      // $1: user_id
      restaurant_id ? Number(restaurant_id) : null,                  // $2
      fetchedAddress || delivery_address || 'Address Not Provided',  // $3: auto-fetched full address
      fetchedLat ? Number(fetchedLat) : null,                        // $4: latitude
      fetchedLng ? Number(fetchedLng) : null,                        // $5: longitude
      itemsJson,                                                     // $6
      Number(item_total || 0),                                       // $7
      Number(tax || 0),                                              // $8
      Number(delivery_fee || 0),                                     // $9
      Number(discount || 0),                                         // $10
      calcTotal,                                                     // $11
      'Pending',                                                     // $12
      payment_status || 'Pending',                                   // $13
      payment_method || 'Cash on Delivery'                           // $14
    ];

    const orderResult = await pool.query(orderQuery, orderValues);
    const newOrder = orderResult.rows[0];

    // Order items insertion logic remains unchanged
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      for (const entry of rawItems) {
        try {
          const dish = entry.item || entry.menu_item || entry;
          const dishId = dish.id || dish.menu_item_id || null;
          const dishName = dish.name || dish.title || 'Food Item';
          const dishPrice = Number(dish.price || 0);
          const dishQty = Number(entry.quantity || entry.qty || 1);

          await pool.query(
            `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price) VALUES ($1, $2, $3, $4, $5)`,
            [newOrder.id, dishId, dishName, dishQty, dishPrice]
          );
        } catch (itemErr) {
          console.warn('Note on order_items insert:', itemErr.message);
        }
      }
    }

    res.status(201).json({
      message: 'Order placed successfully!',
      order_id: newOrder.id,
      orderId: newOrder.id,
      order: newOrder
    });

  } catch (error) {
    console.error('❌ Error placing order:', error);
    res.status(500).json({ message: error.message || 'Database error placing order' });
  }
});
// GET /api/admin/orders
app.get('/api/admin/orders', async (req, res) => {
  try {
    const query = `
      SELECT o.*, COALESCE(r.name, 'Main Kitchen') AS restaurant_name 
      FROM orders o 
      LEFT JOIN restaurants r ON o.restaurant_id = r.id 
      ORDER BY o.id DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching admin orders:', err);
    res.status(500).json({ error: 'Server error fetching orders' });
  }
});

// PATCH /api/orders/:id/status (Update Order Status)
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *;',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json({ message: 'Order status updated', order: result.rows[0] });
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ message: 'Server error updating order status' });
  }
});

// GET /api/orders/:id (Live Tracking Endpoint)
// GET /api/orders/:id (Live Tracking Endpoint)
const getOrderDetails = async (req, res) => {
  const { id } = req.params;

  if (!id || id === 'undefined' || id === 'null' || isNaN(Number(id))) {
    return res.status(400).json({ message: 'Invalid Order ID' });
  }

  try {
    const orderResult = await pool.query(
      `SELECT o.*, 
              COALESCE(r.name, 'Ghar Se') AS restaurant_name,
              r.address AS restaurant_address,
              r.city AS restaurant_city,
              r.image_url AS restaurant_image,
              r.latitude AS restaurant_latitude,
              r.longitude AS restaurant_longitude,
              u.name AS user_name,
              u.phone AS user_phone
       FROM orders o 
       LEFT JOIN restaurants r ON o.restaurant_id = r.id 
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`, 
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const order = orderResult.rows[0];

    let parsedItems = [];
    try {
      const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
      parsedItems = itemsResult.rows;
    } catch (e) {}

    if ((!parsedItems || parsedItems.length === 0) && order.items) {
      try {
        parsedItems = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
      } catch (e) {
        parsedItems = [];
      }
    }

    const lat = order.delivery_latitude ? parseFloat(order.delivery_latitude) : null;
    const lng = order.delivery_longitude ? parseFloat(order.delivery_longitude) : null;
    const restLat = order.restaurant_latitude ? parseFloat(order.restaurant_latitude) : null;
    const restLng = order.restaurant_longitude ? parseFloat(order.restaurant_longitude) : null;

    res.status(200).json({
      ...order,
      order_id: order.id,
      orderId: order.id,
      items: parsedItems,
      status: order.status || 'Placed',
      estimated_time: '33 mins',
      delivery_latitude: lat,
      delivery_longitude: lng,
      restaurant_latitude: restLat,
      restaurant_longitude: restLng,
      customer_location: lat && lng ? { lat, lng } : null,

      customer: {
        name: order.user_name ,
        phone: order.user_phone, 
        address: order.delivery_address,
        lat,
        lng
      },

      restaurant: {
        name: order.restaurant_name,
        address: order.restaurant_address ,
        city: order.restaurant_city ,
        image_url: order.restaurant_image || '',
        lat: restLat,
        lng: restLng
      }
    });
  } catch (error) {
    console.error('Error fetching order tracking:', error);
    res.status(500).json({ message: 'Server error fetching order details' });
  }
};

app.get('/api/orders/:id', getOrderDetails);
app.get('/api/order-tracking/:id', getOrderDetails);
// -------------------------------------------------------------
// RESTAURANT PARTNER PANEL ROUTES (AUTHENTICATION & ORDERS)
// -------------------------------------------------------------

// 1. Register New Restaurant Partner
app.post('/api/restaurant/register', async (req, res) => {
  try {
    const { name, email, password, address, cuisine, cuisine_type, city } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Restaurant name, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const selectedCuisine = cuisine_type || cuisine || 'Multi-Cuisine';

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const queryText = `
      INSERT INTO restaurants (name, city, address, cuisine_type, email, password)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      name, 
      city || 'Ahmedabad', 
      address || '', 
      selectedCuisine, 
      cleanEmail, 
      hashedPassword
    ];

    const result = await pool.query(queryText, values);
    const restaurant = result.rows[0];

    const token = jwt.sign(
      { id: restaurant.id, email: restaurant.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...restaurantWithoutPassword } = restaurant;

    res.status(201).json({
      success: true,
      message: 'Restaurant partner registered successfully!',
      restaurant: restaurantWithoutPassword,
      token
    });
  } catch (dbErr) {
    console.error('Error registering restaurant:', dbErr);

    if (dbErr.code === '23505') {
      return res.status(400).json({ success: false, message: 'Email already registered.' });
    }

    res.status(500).json({ success: false, message: 'Server error registering restaurant' });
  }
});

// 2. Restaurant Partner Login
app.post('/api/restaurant/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Look up restaurant by email
    const result = await pool.query('SELECT * FROM restaurants WHERE LOWER(email) = $1', [cleanEmail]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const restaurant = result.rows[0];

    // Verify hashed password
    if (restaurant.password) {
      const isPasswordValid = await bcrypt.compare(password, restaurant.password);
      if (!isPasswordValid) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }
    }

    // Issue JWT Token
    const token = jwt.sign(
      { id: restaurant.id, email: restaurant.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...restaurantWithoutPassword } = restaurant;

    res.json({
      success: true,
      restaurant: restaurantWithoutPassword,
      token
    });
  } catch (err) {
    console.error('Error logging in restaurant:', err);
    res.status(500).json({ success: false, message: 'Server error logging in' });
  }
});

// PUT /api/restaurants/:id / PATCH /api/restaurants/:id
app.patch('/api/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, address, full_address, cuisine_type, image_url, delivery_time, latitude, longitude } = req.body;

    const updateQuery = `
      UPDATE restaurants 
      SET 
        name = COALESCE($1, name),
        city = COALESCE($2, city),
        address = COALESCE($3, address),
        full_address = COALESCE($4, full_address),
        cuisine_type = COALESCE($5, cuisine_type),
        image_url = COALESCE($6, image_url),
        delivery_time = COALESCE($7, delivery_time),
        latitude = COALESCE($8, latitude),
        longitude = COALESCE($9, longitude)
      WHERE id = $10
      RETURNING *;
    `;

    const values = [
      name || null,
      city || null,
      address || null,
      full_address || null,
      cuisine_type || null,
      image_url || null,
      delivery_time || null,
      latitude !== undefined ? parseFloat(latitude) : null,
      longitude !== undefined ? parseFloat(longitude) : null,
      id
    ];

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    res.json({
      message: 'Restaurant address updated successfully!',
      restaurant: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating restaurant address:', err);
    res.status(500).json({ message: 'Server error updating restaurant address' });
  }
});

// 3. GET Orders Specifically for ONE Restaurant
app.get('/api/restaurant/:restaurantId/orders', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    if (!restaurantId || isNaN(Number(restaurantId))) {
      return res.status(400).json({ error: 'Valid Restaurant ID is required' });
    }

    const query = `
      SELECT o.*, COALESCE(r.name, 'Main Kitchen') AS restaurant_name 
      FROM orders o 
      LEFT JOIN restaurants r ON o.restaurant_id = r.id 
      WHERE o.restaurant_id = $1
      ORDER BY o.id DESC;
    `;
    const result = await pool.query(query, [Number(restaurantId)]);

    // Parse and normalize order JSON items for frontend consumption
    const formattedOrders = result.rows.map(order => {
      let parsedItems = [];
      if (order.items) {
        try {
          parsedItems = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        } catch (e) {
          parsedItems = [];
        }
      }
      return {
        ...order,
        totalAmount: order.final_total || order.item_total || 0,
        customerName: order.delivery_address ? order.delivery_address.split(',')[0] : 'Customer',
        items: parsedItems
      };
    });

    res.json(formattedOrders);
  } catch (err) {
    console.error('Error fetching restaurant partner orders:', err);
    res.status(500).json({ error: 'Server error fetching partner orders' });
  }
});

// Start Express Server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
