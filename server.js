import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import axios from 'axios';
import crypto from 'crypto';

// ES Module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

// ============ MIDDLEWARE ============
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5500', 'https://ltscanteen.vercel.app', 'https://ltscanteen-81tsl2fb2-antoinette21109s-projects.vercel.app', process.env.FRONTEND_URL],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// ============ DATABASE SETUP ============
const db = new Database('./canteen.db');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT,
    phone TEXT,
    role TEXT DEFAULT 'customer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    user_id INTEGER,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    items TEXT NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    payment_method TEXT NOT NULL,
    payment_status TEXT DEFAULT 'pending',
    transaction_id TEXT,
    msisdn TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    transaction_id TEXT UNIQUE,
    provider TEXT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    phone_number TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reference TEXT,
    callback_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create demo admin user
const hashedPassword = bcrypt.hashSync('Admin123!', 10);
const adminStmt = db.prepare(`INSERT OR IGNORE INTO users (username, password, full_name, phone, role) VALUES (?, ?, ?, ?, ?)`);
adminStmt.run('admin@literacytree.com', hashedPassword, 'School Administrator', '+260974754810', 'admin');

// ============ AUTHENTICATION MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

// ============ HELPER FUNCTIONS ============
const generateOrderNumber = () => {
  const date = new Date();
  const timestamp = date.getFullYear().toString() + 
                   (date.getMonth() + 1).toString().padStart(2, '0') + 
                   date.getDate().toString().padStart(2, '0') + 
                   date.getHours().toString().padStart(2, '0') +
                   date.getMinutes().toString().padStart(2, '0') +
                   date.getSeconds().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `LTS-${timestamp}-${random}`;
};

const formatPhoneForAPI = (phone) => {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '260' + cleaned.substring(1);
  } else if (!cleaned.startsWith('260')) {
    cleaned = '260' + cleaned;
  }
  return cleaned;
};

// ============ PAYMENT INTEGRATIONS ============

async function initiateMTNPayment(orderNumber, amount, phoneNumber, orderId) {
  const formattedPhone = formatPhoneForAPI(phoneNumber);
  const transactionId = crypto.randomUUID();
  
  // Store transaction record
  const insertPayment = db.prepare(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
                                   VALUES (?, ?, ?, ?, ?, 'pending')`);
  insertPayment.run(orderId, transactionId, 'mtn', amount, phoneNumber);

  // PRODUCTION MODE: If MTN API URL exists in .env, hit the real API
  if (process.env.MTN_API_URL && process.env.MTN_SUBSCRIPTION_KEY) {
    try {
      const auth = Buffer.from(`${process.env.MTN_API_USER}:${process.env.MTN_API_KEY}`).toString('base64');
      const tokenResponse = await axios.post(
        `${process.env.MTN_API_URL}/collection/token/`,
        {},
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Ocp-Apim-Subscription-Key': process.env.MTN_SUBSCRIPTION_KEY
          }
        }
      );
      const bearerToken = tokenResponse.data.access_token;

      await axios.post(`${process.env.MTN_API_URL}/collection/v1_0/requesttopay`, {
        amount: amount.toString(),
        currency: 'ZMW',
        externalId: orderNumber,
        payer: { partyIdType: 'MSISDN', partyId: formattedPhone },
        payerMessage: `Payment for order ${orderNumber}`,
        payeeNote: `Literacy Tree Canteen Order`
      }, {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'X-Reference-Id': transactionId,
          'X-Callback-Url': process.env.MTN_CALLBACK_URL || '',
          'Ocp-Apim-Subscription-Key': process.env.MTN_SUBSCRIPTION_KEY
        }
      });
    } catch (error) {
      console.error('MTN API Error, falling back to simulation:', error.message);
    }
  }

  // SANDBOX MODE: Simulate the USSD Push callback
  console.log(`[MTN] Payment initiated: Order ${orderNumber}, Amount K${amount}, Phone ${formattedPhone}, Ref: ${transactionId}`);
  setTimeout(() => {
    simulatePaymentCallback('mtn', transactionId, orderId, orderNumber, amount);
  }, 3000);
  
  return { 
    transactionId, 
    status: 'pending', 
    message: 'Payment initiated. Please check your MTN Mobile Money for payment prompt.' 
  };
}

async function initiateAirtelPayment(orderNumber, amount, phoneNumber, orderId) {
  const formattedPhone = formatPhoneForAPI(phoneNumber);
  const transactionId = `AIR-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  
  // Store transaction record
  const insertPayment = db.prepare(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
                                   VALUES (?, ?, ?, ?, ?, 'pending')`);
  insertPayment.run(orderId, transactionId, 'airtel', amount, phoneNumber);

  // PRODUCTION MODE: If Airtel API URL exists in .env, hit the real API
  if (process.env.AIRTEL_API_URL && process.env.AIRTEL_CLIENT_ID) {
    try {
      const tokenResponse = await axios.post(
        `${process.env.AIRTEL_API_URL}/auth/oauth2/token`,
        {
          client_id: process.env.AIRTEL_CLIENT_ID,
          client_secret: process.env.AIRTEL_CLIENT_SECRET,
          grant_type: 'client_credentials'
        }
      );
      const bearerToken = tokenResponse.data.access_token;

      await axios.post(`${process.env.AIRTEL_API_URL}/merchant/v1/payments/`, {
        reference: orderNumber,
        subscriber: { country: "ZM", currency: "ZMW", msisdn: formattedPhone },
        transaction: { amount: amount.toString(), country: "ZM", currency: "ZMW", id: transactionId }
      }, {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'X-API-Key': process.env.AIRTEL_API_KEY,
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      console.error('Airtel API Error, falling back to simulation:', error.message);
    }
  }

  // SANDBOX MODE: Simulate the USSD Push callback
  console.log(`[Airtel] Payment initiated: Order ${orderNumber}, Amount K${amount}, Phone ${formattedPhone}, Ref: ${transactionId}`);
  setTimeout(() => {
    simulatePaymentCallback('airtel', transactionId, orderId, orderNumber, amount);
  }, 3000);
  
  return { 
    transactionId, 
    status: 'pending', 
    message: 'Payment initiated. Please check your Airtel Money for payment prompt.' 
  };
}

function simulatePaymentCallback(provider, transactionId, orderId, orderNumber, amount) {
  console.log(`[SIMULATION] ${provider.toUpperCase()} payment successful for order ${orderNumber}`);
  
  const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`);
  updatePayment.run(JSON.stringify({ status: 'success', transactionId, amount, provider }), transactionId);
  
  const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  updateOrder.run(orderId);
}

// ============ AUTHENTICATION ROUTES ============

// Register
app.post('/api/register', [
  body('username').isEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('full_name').optional().isString(),
  body('phone').optional().isString()
], async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password, full_name, phone } = req.body;

  try {
    // Check if user already exists
    const checkUser = db.prepare('SELECT id FROM users WHERE username = ?');
    const existingUser = checkUser.get(username);
    
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    // Hash password
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);

    // Insert new user
    const insertUser = db.prepare(
      'INSERT INTO users (username, password, full_name, phone, role) VALUES (?, ?, ?, ?, ?)'
    );
    const result = insertUser.run(username, hashedPassword, full_name || '', phone || '', 'customer');
    
    // Generate JWT
    const token = jwt.sign(
      { id: result.lastInsertRowid, username, role: 'customer' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: result.lastInsertRowid,
        username,
        full_name: full_name || '',
        phone: phone || '',
        role: 'customer'
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', [
  body('username').isEmail().withMessage('Please enter a valid email'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password } = req.body;

  try {
    // Find user
    const getUser = db.prepare('SELECT * FROM users WHERE username = ?');
    const user = getUser.get(username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isValidPassword = bcrypt.compareSync(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
app.get('/api/me', authenticateToken, (req, res) => {
  try {
    const getUser = db.prepare('SELECT id, username, full_name, phone, role, created_at FROM users WHERE id = ?');
    const user = getUser.get(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user profile
app.put('/api/profile', authenticateToken, [
  body('full_name').optional().isString(),
  body('phone').optional().isString(),
  body('currentPassword').optional().isString(),
  body('newPassword').optional().isLength({ min: 6 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { full_name, phone, currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  try {
    let updates = [];
    let params = [];

    if (full_name !== undefined) {
      updates.push('full_name = ?');
      params.push(full_name);
    }

    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone);
    }

    if (newPassword) {
      // Verify current password
      const getUser = db.prepare('SELECT password FROM users WHERE id = ?');
      const user = getUser.get(userId);
      
      if (!bcrypt.compareSync(currentPassword, user.password)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      
      const hashedPassword = bcrypt.hashSync(newPassword, 10);
      updates.push('password = ?');
      params.push(hashedPassword);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(userId);
    const updateUser = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`);
    updateUser.run(...params);

    // Get updated user
    const getUser = db.prepare('SELECT id, username, full_name, phone, role FROM users WHERE id = ?');
    const updatedUser = getUser.get(userId);

    res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============ API ROUTES ============

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Protected order creation - requires authentication
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { items, paymentMethod, phoneNumber, customerName } = req.body;
    const userId = req.user.id;
    
    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (!paymentMethod || !['mtn', 'airtel'].includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = generateOrderNumber();
    
    const insertOrder = db.prepare(`INSERT INTO orders (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(orderNumber, userId, customerName || req.user.username, phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending');
    const orderId = info.lastInsertRowid;
    
    try {
      let paymentResult;
      if (paymentMethod === 'mtn') {
        paymentResult = await initiateMTNPayment(orderNumber, total, phoneNumber, orderId);
      } else {
        paymentResult = await initiateAirtelPayment(orderNumber, total, phoneNumber, orderId);
      }
      
      res.json({
        success: true,
        orderNumber: orderNumber,
        transactionId: paymentResult.transactionId,
        paymentStatus: paymentResult.status,
        message: paymentResult.message
      });
      
    } catch (paymentError) {
      console.error('Payment initiation error:', paymentError);
      res.status(500).json({ error: 'Payment initiation failed', details: paymentError.message });
    }
    
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Guest checkout (without authentication)
app.post('/api/guest-checkout', async (req, res) => {
  try {
    const { items, paymentMethod, customerName, phoneNumber } = req.body;
    
    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (!paymentMethod || !['mtn', 'airtel'].includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = generateOrderNumber();
    
    const insertOrder = db.prepare(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(orderNumber, customerName || 'Guest', phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending');
    const orderId = info.lastInsertRowid;
    
    try {
      let paymentResult;
      if (paymentMethod === 'mtn') {
        paymentResult = await initiateMTNPayment(orderNumber, total, phoneNumber, orderId);
      } else {
        paymentResult = await initiateAirtelPayment(orderNumber, total, phoneNumber, orderId);
      }
      
      res.json({
        success: true,
        orderNumber: orderNumber,
        transactionId: paymentResult.transactionId,
        paymentStatus: paymentResult.status,
        message: paymentResult.message
      });
      
    } catch (paymentError) {
      console.error('Payment initiation error:', paymentError);
      res.status(500).json({ error: 'Payment initiation failed', details: paymentError.message });
    }
    
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to process checkout' });
  }
});

app.get('/api/payment-status/:orderNumber', async (req, res) => {
  const { orderNumber } = req.params;
  const getOrder = db.prepare(`SELECT o.*, p.status as payment_status, p.transaction_id 
                              FROM orders o LEFT JOIN payments p ON o.id = p.order_id 
                              WHERE o.order_number = ?`);
  const order = getOrder.get(orderNumber);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  res.json({
    orderNumber: order.order_number,
    totalAmount: order.total_amount,
    paymentStatus: order.payment_status,
    orderStatus: order.status
  });
});

// Get user's orders
app.get('/api/my-orders', authenticateToken, (req, res) => {
  try {
    const getOrders = db.prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`);
    const orders = getOrders.all(req.user.id);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/payments/mtn-callback', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const callbackData = JSON.parse(req.body.toString());
    const transactionId = callbackData.referenceId;
    if (callbackData.status === 'SUCCESSFUL') {
      const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`);
      updatePayment.run(JSON.stringify(callbackData), transactionId);
      
      const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP 
                                     WHERE id = (SELECT order_id FROM payments WHERE transaction_id = ?)`);
      updateOrder.run(transactionId);
    }
    res.json({ status: 'received' });
  } catch (error) {
    res.status(200).json({ status: 'error' });
  }
});

app.post('/api/payments/airtel-callback', express.json(), async (req, res) => {
  try {
    const callbackData = req.body;
    const transactionId = callbackData.transaction?.id;
    if (callbackData.transaction?.status === 'SUCCESS') {
      const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`);
      updatePayment.run(JSON.stringify(callbackData), transactionId);
      
      const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP 
                                     WHERE id = (SELECT order_id FROM payments WHERE transaction_id = ?)`);
      updateOrder.run(transactionId);
    }
    res.json({ status: 'received' });
  } catch (error) {
    res.status(200).json({ status: 'error' });
  }
});

// Admin routes
app.get('/api/admin/orders', authenticateToken, isAdmin, (req, res) => {
  const getOrders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`);
  const orders = getOrders.all();
  res.json(orders);
});

app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  const getUsers = db.prepare(`SELECT id, username, full_name, phone, role, created_at FROM users ORDER BY created_at DESC`);
  const users = getUsers.all();
  res.json(users);
});

app.put('/api/admin/orders/:orderId/status', authenticateToken, isAdmin, (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;
  
  if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    const updateOrder = db.prepare(`UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const result = updateOrder.run(status, orderId);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    res.json({ message: 'Order status updated successfully' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ============ SERVER START ============
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   LITERACY TREE CANTEEN - PRODUCTION BACKEND         ║
╠═══════════════════════════════════════════════════════╣
║   🚀 Server running on: http://localhost:${PORT}        ║
║   📱 MTN Mobile Money: ${process.env.MTN_API_URL ? '✅ Live API' : '⚠️ Sandbox Mode'}    ║
║   💛 Airtel Money: ${process.env.AIRTEL_API_URL ? '✅ Live API' : '⚠️ Sandbox Mode'}      ║
║   💳 Payment methods: MTN, Airtel                     ║
║   🔐 Authentication: JWT enabled                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});