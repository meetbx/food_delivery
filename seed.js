console.log(require.resolve('./db'));

const pool = require('./db');

console.log(pool);
console.log(typeof pool.query);
const fs = require('fs');
const path = require('path');

async function seedDatabase() {
  try {
    console.log("Creating tables...");
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSql);

    console.log("Seeding restaurant data...");
    // Clear existing data
    await pool.query('TRUNCATE restaurants, menu_items CASCADE;');

    // 1. Meghana Foods
    const r1 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Meghana Foods', 'Biryani, Andhra, North Indian', 'Koramangala 5th Block', 'Bengaluru', 4.5, 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600', '25-30 min', 500)
      RETURNING id;
    `);
    const r1Id = r1.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r1Id}, 'Meghana Special Chicken Biryani', 'Authentic spicy Andhra style biryani with marinated chicken pieces.', 340.00, 'Biryani', false, 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=300'),
      (${r1Id}, 'Paneer Biryani', 'Fragrant basmati rice layered with spiced cottage cheese cubes.', 290.00, 'Biryani', true, 'https://images.unsplash.com/photo-1645177628172-a94c1f96e6db?w=300'),
      (${r1Id}, 'Chicken 65', 'Deep-fried chicken pieces tossed in spicy South Indian curry leaf sauce.', 280.00, 'Starters', false, 'https://images.unsplash.com/photo-1610057099443-fde8c4d50f91?w=300');
    `);

    // 2. Truffles
    const r2 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Truffles', 'American, Burgers, Desserts', 'Indiranagar 100ft Road', 'Bengaluru', 4.6, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600', '30-35 min', 600)
      RETURNING id;
    `);
    const r2Id = r2.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r2Id}, 'All American Cheese Burger', 'Juicy grilled beef/chicken patty loaded with cheddar and fresh lettuce.', 260.00, 'Burgers', false, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300'),
      (${r2Id}, 'Crispy Veg Burger', 'Golden crunchy vegetable patty with signature mayonnaise.', 180.00, 'Burgers', true, 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300'),
      (${r2Id}, 'Dutch Truffle Cake Slice', 'Rich dark chocolate ganache layered slice.', 150.00, 'Desserts', true, 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=300');
    `);

    // 3. Burger King
    const r3 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Burger King', 'American, Fast Food', 'MG Road', 'Bengaluru', 4.3, 'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=600', '20-25 min', 350)
      RETURNING id;
    `);
    const r3Id = r3.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r3Id}, 'Whopper Burger', 'Signature flame-grilled patty topped with juicy tomatoes.', 199.00, 'Burgers', false, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300'),
      (${r3Id}, 'Crispy Veg Whopper', 'Crispy patty filled with vegetables and tangy sauce.', 169.00, 'Burgers', true, 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300');
    `);

    // 4. Domino''s Pizza
    const r4 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Domino''s Pizza', 'Pizzas, Italian', 'HSR Layout Sector 1', 'Bengaluru', 4.4, 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600', '25-30 min', 400)
      RETURNING id;
    `);
    const r4Id = r4.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r4Id}, 'Farmhouse Pizza', 'Loaded with fresh capsicum, onion, tomato, and grilled mushroom.', 399.00, 'Pizzas', true, 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=300'),
      (${r4Id}, 'Peppy Paneer Pizza', 'Chunky paneer with crisp capsicum and spicy red pepper.', 459.00, 'Pizzas', true, 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=300');
    `);

    // 5. Haldiram''s
    const r5 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Haldiram''s', 'North Indian, Sweets, Street Food', 'Whitefield Main Rd', 'Bengaluru', 4.5, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600', '30-35 min', 300)
      RETURNING id;
    `);
    const r5Id = r5.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r5Id}, 'Chole Bhature', 'Two fluffy bhaturas served with spicy chickpea curry and pickle.', 180.00, 'Main Course', true, 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=300'),
      (${r5Id}, 'Raj Kachori', 'Crispy large puri filled with potatoes, sprouts, yogurt and chutneys.', 140.00, 'Chaats', true, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=300');
    `);

    // 6. Subway
    const r6 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Subway', 'Healthy Food, Salads, Sandwiches', 'Jayanagar 4th Block', 'Bengaluru', 4.1, 'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=600', '15-20 min', 450)
      RETURNING id;
    `);
    const r6Id = r6.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r6Id}, 'Veg Shammi Sub', 'A spiced lentil patty layered with your choice of veggies and sauce.', 240.00, 'Subs', true, 'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=300'),
      (${r6Id}, 'Chicken Teriyaki Sub', 'Tender chicken strips marinated in teriyaki sauce.', 290.00, 'Subs', false, 'https://images.unsplash.com/photo-1553909489-cd47e0907980?w=300');
    `);

    // 7. KFC
    const r7 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('KFC', 'American, Fast Food, Chicken', 'Church Street', 'Bengaluru', 4.2, 'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600', '25-30 min', 500)
      RETURNING id;
    `);
    const r7Id = r7.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r7Id}, 'Hot & Crispy Chicken - 4 Pcs', 'Signature crunchy fried chicken pieces.', 440.00, 'Chicken', false, 'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=300'),
      (${r7Id}, 'Zinger Burger', 'Crispy chicken fillet with fresh lettuce and mayo.', 199.00, 'Burgers', false, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300');
    `);

    // 8. Bikanervala
    const r8 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Bikanervala', 'Street Food, Desserts, North Indian', 'BTM Layout 2nd Stage', 'Bengaluru', 4.3, 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=600', '35-40 min', 250)
      RETURNING id;
    `);
    const r8Id = r8.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r8Id}, 'Special Pav Bhaji', 'Butter-loaded spicy mashed vegetable curry with roasted pav.', 160.00, 'Street Food', true, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=300'),
      (${r8Id}, 'Rasgulla (2 Pcs)', 'Soft spongy cottage cheese balls soaked in light sugar syrup.', 80.00, 'Sweets', true, 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=300');
    `);

    // 9. La Pino''z Pizza
    const r9 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('La Pino''z Pizza', 'Italian, Pastas, Pizzas', 'Bellandur Main Road', 'Bengaluru', 4.0, 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=600', '20-25 min', 350)
      RETURNING id;
    `);
    const r9Id = r9.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r9Id}, '7 Cheese Pizza', 'Loaded with seven varieties of rich molten cheese.', 420.00, 'Pizzas', true, 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=300'),
      (${r9Id}, 'Cheesy Garlic Bread', 'Freshly baked bread with herbs, garlic, and melted cheese.', 140.00, 'Sides', true, 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=300');
    `);

    // 10. Wow! Momo
    const r10 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Wow! Momo', 'Tibetan, Asian, Fast Food', 'Koramangala 7th Block', 'Bengaluru', 4.2, 'https://images.unsplash.com/photo-1625220194771-7ebdea0b70b9?w=600', '15-20 min', 200)
      RETURNING id;
    `);
    const r10Id = r10.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r10Id}, 'Steamed Chicken Momos', 'Steamed dumplings filled with minced juicy chicken and herbs.', 160.00, 'Momos', false, 'https://images.unsplash.com/photo-1625220194771-7ebdea0b70b9?w=300'),
      (${r10Id}, 'Pan Fried Paneer Momos in Schezwan', 'Fried veg momos tossed in spicy fiery Schezwan sauce.', 190.00, 'Momos', true, 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=300');
    `);

    // 11. The Belgian Waffle Co.
    const r11 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('The Belgian Waffle Co.', 'Desserts, Waffles, Beverages', 'JP Nagar 2nd Phase', 'Bengaluru', 4.6, 'https://images.unsplash.com/photo-1562376552-0d160a2f238d?w=600', '20-25 min', 300)
      RETURNING id;
    `);
    const r11Id = r11.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r11Id}, 'Naked Nutella Waffle', 'Crispy waffle layered with rich Nutella spread.', 170.00, 'Waffles', true, 'https://images.unsplash.com/photo-1562376552-0d160a2f238d?w=300'),
      (${r11Id}, 'Red Velvet Waffle', 'Red velvet waffle base with white chocolate filling.', 150.00, 'Waffles', true, 'https://images.unsplash.com/photo-1587314168485-3236d6710814?w=300');
    `);

    // 12. Biryani By Kilo
    const r12 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Biryani By Kilo', 'Biryani, Mughlai, Hyderabadi', 'Sarjapur Road', 'Bengaluru', 4.4, 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600', '40-45 min', 700)
      RETURNING id;
    `);
    const r12Id = r12.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r12Id}, 'Hyderabadi Chicken Dum Biryani', 'Fresh hand-crafted dum biryani cooked in individual clay pots.', 425.00, 'Biryani', false, 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=300'),
      (${r12Id}, 'Mutton Galouti Kebab', 'Melt-in-mouth tender lamb kebabs infused with Indian aromatic spices.', 395.00, 'Kebabs', false, 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=300');
    `);

    // 13. Saravana Bhavan
    const r13 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Saravana Bhavan', 'South Indian, Breakfast', 'Malleswaram 8th Cross', 'Bengaluru', 4.4, 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4?w=600', '25-30 min', 250)
      RETURNING id;
    `);
    const r13Id = r13.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r13Id}, 'Ghee Roast Masala Dosa', 'Crispy golden crepe smeared with pure ghee, served with potato masala.', 130.00, 'South Indian', true, 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4?w=300'),
      (${r13Id}, 'Idli Vada Combo', 'Two steamed rice cakes with one crispy lentil donut served with chutneys.', 95.00, 'South Indian', true, 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=300');
    `);

    // 14. Starbucks
    const r14 = await pool.query(`
      INSERT INTO restaurants (name, cuisine_type, address, city, rating, image_url, delivery_time, price_for_two)
      VALUES ('Starbucks', 'Cafe, Beverages, Bakery', 'Lavelle Road', 'Bengaluru', 4.3, 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=600', '20-25 min', 600)
      RETURNING id;
    `);
    const r14Id = r14.rows[0].id;

    await pool.query(`
      INSERT INTO menu_items (restaurant_id, name, description, price, category, is_veg, image_url) VALUES
      (${r14Id}, 'Java Chip Frappuccino', 'Coffee blended with mocha sauce, rich chips, milk and ice topped with whip.', 345.00, 'Beverages', true, 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=300'),
      (${r14Id}, 'Butter Croissant', 'Classic flaky European butter croissant baked to golden perfection.', 180.00, 'Bakery', true, 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=300');
    `);

    console.log("✅ Database successfully created and seeded with 14 restaurants!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding database:", err);
    process.exit(1);
  }
}

seedDatabase();