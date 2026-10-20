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
import {
  createCloudinaryUploadSignature,
  formatMenuItem,
  initializeMenuDatabase,
  resolveOrderItems,
  saveMenuItem,
  validateMenuItem
} from './backend/src/config/menu.js';

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
initializeMenuDatabase(db);

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
    try {
      const account = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(user.id);
      if (!account) {
        return res.status(401).json({ error: 'Account not found.' });
      }
      req.user = {
        ...user,
        ...account,
        authSessionId: user.jti || `${account.id}:${user.iat}`
      };
      next();
    } catch (error) {
      console.error('Authentication error:', error);
      res.status(500).json({ error: 'Authentication failed.' });
    }
  });
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

const isStaffOrAdmin = (req, res, next) => {
  if (!['staff', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff access required.' });
  }
  next();
};

const requireMenuAccess = (req, res, next) => {
  if (req.user.role === 'admin') {
    return next();
  }
  try {
    const access = db.prepare(`
      SELECT status FROM menu_access_requests
      WHERE user_id = ? AND session_id = ?
    `).get(req.user.id, req.user.authSessionId);
    if (access?.status !== 'approved') {
      return res.status(403).json({ error: 'Administrator approval is required for menu controls in this session.' });
    }
    next();
  } catch (error) {
    console.error('Menu access verification error:', error);
    res.status(500).json({ error: 'Unable to verify menu access.' });
  }
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

async function initiateZynlePayment(orderNumber, amount, phoneNumber, orderId) {
  const formattedPhone = phoneNumber.replace(/\D/g, '');
  const transactionId = crypto.randomUUID();

  const insertPayment = db.prepare(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
                                   VALUES (?, ?, ?, ?, ?, 'pending')`);
  insertPayment.run(orderId, transactionId, 'zynle', amount, phoneNumber);

  const zynleUrl = process.env.ZYNLE_API_URL;
  const zynleKey = process.env.ZYNLE_API_KEY;

  if (zynleUrl && zynleKey) {
    const baseUrl = zynleUrl.replace(/\/$/, '');
    const callbackUrl = process.env.ZYNLE_CALLBACK_URL || `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/api/payments/zynle-callback`;
    const payload = {
      merchantId: process.env.ZYNLE_MERCHANT_ID,
      merchant_id: process.env.ZYNLE_MERCHANT_ID,
      amount: Number(amount).toFixed(2),
      currency: process.env.CURRENCY || 'ZMW',
      orderId: orderNumber,
      order_id: orderNumber,
      externalId: orderNumber,
      external_id: orderNumber,
      phoneNumber: formattedPhone,
      customerPhone: formattedPhone,
      callbackUrl,
      callback_url: callbackUrl,
      metadata: { orderId, orderNumber, transactionId, provider: 'zynle' }
    };

    const endpointCandidates = [
      `${baseUrl}/payments/initiate`,
      `${baseUrl}/api/payments/initiate`,
      `${baseUrl}/payment/initiate`,
      `${baseUrl}/initiate-payment`
    ];

    let lastError = null;
    for (const endpoint of endpointCandidates) {
      try {
        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${zynleKey}`,
            'Content-Type': 'application/json',
            'X-API-Key': zynleKey
          },
          timeout: 20000
        });

        const reference = response.data?.reference || response.data?.transactionId || response.data?.paymentId || response.data?.data?.reference || response.data?.data?.transactionId || transactionId;
        const updatePaymentRef = db.prepare(`UPDATE payments SET reference = ? WHERE transaction_id = ?`);
        updatePaymentRef.run(reference, transactionId);

        return {
          transactionId: reference,
          status: 'pending',
          message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
        };
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        if (status !== 404 && status !== 405) {
          throw new Error(error.response?.data?.message || error.message || 'Zynle payment initiation failed.');
        }
      }
    }

    throw new Error(lastError?.response?.data?.message || 'ZynlePay API endpoint is not reachable using the configured credentials.');
  }

  const newTransactionId = transactionId;
  console.log(`[ZYNLE] Payment initiated locally: Order ${orderNumber}, Amount K${amount}, Phone ${formattedPhone}, Ref: ${newTransactionId}`);
  setTimeout(() => {
    const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`);
    updatePayment.run(JSON.stringify({ status: 'success', transactionId: newTransactionId, amount, provider: 'zynle' }), newTransactionId);

    const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    updateOrder.run(orderId);
  }, 3000);

  return {
    transactionId: newTransactionId,
    status: 'pending',
    message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
  };
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
      { id: result.lastInsertRowid, username, role: 'customer', jti: crypto.randomUUID() },
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
  body('password').notEmpty().withMessage('Password is required'),
  body('role').optional().isIn(['parent', 'staff', 'admin']).withMessage('Please select a valid account type')
], async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password } = req.body;
  const requestedRole = req.body.role || 'parent';

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

    const userRole = user.role === 'parent' ? 'customer' : user.role;
    const expectedRole = requestedRole === 'parent' ? 'customer' : requestedRole;
    if (userRole !== expectedRole) {
      return res.status(403).json({ error: 'This account does not have access to the selected sign-in.' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, role: userRole, jti: crypto.randomUUID() },
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
        role: userRole
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

app.get('/api/menu', (req, res) => {
  try {
    const menu = db.prepare('SELECT * FROM menu_items ORDER BY category, name').all();
    res.json(menu.map((item) => formatMenuItem(item)));
  } catch (error) {
    console.error('Menu fetch error:', error);
    res.status(500).json({ error: 'Unable to load the menu.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, paymentMethod, customerName, phoneNumber, userId, user } = req.body;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (!paymentMethod || paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

    let order;
    try {
      order = resolveOrderItems(db, items);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const total = order.total;
    const orderNumber = generateOrderNumber();
    const resolvedCustomerName = customerName || user?.full_name || user?.username || 'Guest';

    const insertOrder = userId
      ? db.prepare(`INSERT INTO orders (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      : db.prepare(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const info = userId
      ? insertOrder.run(orderNumber, userId, resolvedCustomerName, phoneNumber, JSON.stringify(order.items), total, paymentMethod, 'pending', phoneNumber, 'pending')
      : insertOrder.run(orderNumber, resolvedCustomerName, phoneNumber, JSON.stringify(order.items), total, paymentMethod, 'pending', phoneNumber, 'pending');
    const orderId = info.lastInsertRowid;

    try {
      const paymentResult = await initiateZynlePayment(orderNumber, total, phoneNumber, orderId);
      res.json({
        success: true,
        orderNumber,
        transactionId: paymentResult.transactionId,
        paymentStatus: paymentResult.status,
        message: paymentResult.message
      });
    } catch (paymentError) {
      console.error('Payment initiation error:', paymentError);
      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      res.status(503).json({ error: paymentError.message });
    }
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ error: 'Failed to process checkout' });
  }
});

// Protected order creation - requires authentication
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { items, paymentMethod, phoneNumber, customerName } = req.body;
    const userId = req.user.id;
    
    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
    let order;
    try {
      order = resolveOrderItems(db, items);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const total = order.total;
    const orderNumber = generateOrderNumber();
    
    const insertOrder = db.prepare(`INSERT INTO orders (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(orderNumber, userId, customerName || req.user.username, phoneNumber, JSON.stringify(order.items), total, paymentMethod, 'pending', phoneNumber, 'pending');
    const orderId = info.lastInsertRowid;
    
    try {
      let paymentResult;
      paymentResult = await initiateZynlePayment(orderNumber, total, phoneNumber, orderId);
      
      res.json({
        success: true,
        orderNumber: orderNumber,
        transactionId: paymentResult.transactionId,
        paymentStatus: paymentResult.status,
        message: paymentResult.message
      });
      
    } catch (paymentError) {
      console.error('Payment initiation error:', paymentError);
      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      res.status(503).json({ error: paymentError.message });
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
    if (paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
    let order;
    try {
      order = resolveOrderItems(db, items);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const total = order.total;
    const orderNumber = generateOrderNumber();
    
    const insertOrder = db.prepare(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(orderNumber, customerName || 'Guest', phoneNumber, JSON.stringify(order.items), total, paymentMethod, 'pending', phoneNumber, 'pending');
    const orderId = info.lastInsertRowid;
    
    try {
      let paymentResult;
      paymentResult = await initiateZynlePayment(orderNumber, total, phoneNumber, orderId);
      
      res.json({
        success: true,
        orderNumber: orderNumber,
        transactionId: paymentResult.transactionId,
        paymentStatus: paymentResult.status,
        message: paymentResult.message
      });
      
    } catch (paymentError) {
      console.error('Payment initiation error:', paymentError);
      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      res.status(503).json({ error: paymentError.message });
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

app.post('/api/payments/zynle-callback', express.json(), async (req, res) => {
  try {
    const callbackData = req.body || {};
    const status = String(callbackData.status || callbackData.state || callbackData.data?.status || '').toUpperCase();
    const transactionId = callbackData.transactionId || callbackData.reference || callbackData.paymentId || callbackData.data?.transactionId || callbackData.id;

    if (transactionId && ['SUCCESS', 'PAID', 'COMPLETED', 'APPROVED'].includes(status)) {
      const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ? OR reference = ?`);
      updatePayment.run(JSON.stringify(callbackData), transactionId, transactionId);

      const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP 
                                     WHERE id = (SELECT order_id FROM payments WHERE transaction_id = ? OR reference = ?)`);
      updateOrder.run(transactionId, transactionId);
    }

    res.json({ status: 'received' });
  } catch (error) {
    res.status(200).json({ status: 'error' });
  }
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

// Admin routes
app.get('/api/menu/access', authenticateToken, isStaffOrAdmin, (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ status: 'approved', admin: true });
  }
  const access = db.prepare(`
    SELECT status, requested_at, reviewed_at
    FROM menu_access_requests
    WHERE user_id = ? AND session_id = ?
  `).get(req.user.id, req.user.authSessionId);
  res.json(access || { status: 'not_requested' });
});

app.post('/api/menu/access-requests', authenticateToken, isStaffOrAdmin, (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ status: 'approved', admin: true });
  }
  try {
    const existing = db.prepare(`
      SELECT id, status FROM menu_access_requests
      WHERE user_id = ? AND session_id = ?
    `).get(req.user.id, req.user.authSessionId);
    if (existing?.status === 'approved' || existing?.status === 'pending') {
      return res.json({ status: existing.status });
    }
    if (existing) {
      db.prepare(`
        UPDATE menu_access_requests
        SET status = 'pending', requested_at = CURRENT_TIMESTAMP, reviewed_by = NULL, reviewed_at = NULL
        WHERE id = ?
      `).run(existing.id);
    } else {
      db.prepare(`
        INSERT INTO menu_access_requests (user_id, session_id)
        VALUES (?, ?)
      `).run(req.user.id, req.user.authSessionId);
    }
    res.status(201).json({ status: 'pending' });
  } catch (error) {
    console.error('Menu access request error:', error);
    res.status(500).json({ error: 'Unable to request menu access.' });
  }
});

app.post('/api/menu/upload-signature', authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Image uploads are not configured. Contact the administrator.' });
  }
  const timestamp = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp,
    folder: 'ltscanteen/menu',
    signature: createCloudinaryUploadSignature(CLOUDINARY_API_SECRET, timestamp)
  });
});

app.get('/api/menu/changes/mine', authenticateToken, isStaffOrAdmin, (req, res) => {
  const changes = db.prepare(`
    SELECT id, item_id, action, payload, status, review_note, created_at, reviewed_at
    FROM menu_change_requests WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id).map((change) => ({ ...change, payload: JSON.parse(change.payload) }));
  res.json(changes);
});

app.post('/api/menu/changes', authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
  const itemId = req.body.itemId == null || req.body.itemId === '' ? null : Number(req.body.itemId);
  if (itemId !== null && (!Number.isInteger(itemId) || itemId <= 0)) {
    return res.status(400).json({ error: 'Invalid menu item ID.' });
  }
  const action = itemId === null ? 'create' : 'update';
  let payload;
  try {
    payload = validateMenuItem(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (itemId !== null && !db.prepare('SELECT id FROM menu_items WHERE id = ?').get(itemId)) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }
  try {
    if (req.user.role === 'admin') {
      const savedId = saveMenuItem(db, itemId, payload);
      return res.status(itemId === null ? 201 : 200).json({
        status: 'approved',
        item: formatMenuItem(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(savedId))
      });
    }
    const result = db.prepare(`
      INSERT INTO menu_change_requests (user_id, session_id, item_id, action, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, req.user.authSessionId, itemId, action, JSON.stringify(payload));
    res.status(202).json({ status: 'pending', requestId: result.lastInsertRowid });
  } catch (error) {
    console.error('Menu change submission error:', error);
    res.status(500).json({ error: 'Unable to submit menu change for review.' });
  }
});

app.get('/api/admin/menu/access-requests', authenticateToken, isAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT r.id, r.user_id, r.session_id, r.status, r.requested_at,
      u.full_name, u.username
    FROM menu_access_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.requested_at ASC
  `).all();
  res.json(requests);
});

app.put('/api/admin/menu/access-requests/:requestId', authenticateToken, isAdmin, [
  body('decision').isIn(['approved', 'denied']).withMessage('Choose approve or deny')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid access request ID.' });
  }
  const result = db.prepare(`
    UPDATE menu_access_requests
    SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(req.body.decision, req.user.id, requestId);
  if (!result.changes) {
    return res.status(404).json({ error: 'Pending access request not found.' });
  }
  res.json({ status: req.body.decision });
});

app.get('/api/admin/menu/changes', authenticateToken, isAdmin, (req, res) => {
  const changes = db.prepare(`
    SELECT c.id, c.item_id, c.action, c.payload, c.created_at,
      u.full_name, u.username, m.name AS current_name,
      m.price AS current_price, m.description AS current_description,
      m.image_url AS current_image_url, m.is_available AS current_is_available
    FROM menu_change_requests c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN menu_items m ON m.id = c.item_id
    WHERE c.status = 'pending'
    ORDER BY c.created_at ASC
  `).all().map((change) => ({ ...change, payload: JSON.parse(change.payload) }));
  res.json(changes);
});

app.put('/api/admin/menu/changes/:changeId/review', authenticateToken, isAdmin, [
  body('decision').isIn(['approved', 'denied']).withMessage('Choose approve or deny'),
  body('reviewNote').optional().isString().isLength({ max: 500 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  const changeId = Number(req.params.changeId);
  if (!Number.isInteger(changeId) || changeId <= 0) {
    return res.status(400).json({ error: 'Invalid menu change ID.' });
  }
  try {
    const review = db.transaction(() => {
      const change = db.prepare(`
        SELECT * FROM menu_change_requests WHERE id = ? AND status = 'pending'
      `).get(changeId);
      if (!change) return false;
      if (req.body.decision === 'approved') {
        saveMenuItem(db, change.item_id, validateMenuItem(JSON.parse(change.payload)));
      }
      db.prepare(`
        UPDATE menu_change_requests
        SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body.decision, req.body.reviewNote || null, req.user.id, changeId);
      return true;
    });
    if (!review()) {
      return res.status(404).json({ error: 'Pending menu change not found.' });
    }
    res.json({ status: req.body.decision });
  } catch (error) {
    console.error('Menu change review error:', error);
    res.status(400).json({ error: error.message || 'Unable to review menu change.' });
  }
});

app.get('/api/admin/orders', authenticateToken, isStaffOrAdmin, (req, res) => {
  const getOrders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`);
  const orders = getOrders.all();
  res.json(orders);
});

app.post('/api/admin/staff', authenticateToken, isAdmin, [
  body('username').isEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('full_name').optional().isString(),
  body('phone').optional().isString()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password, full_name, phone } = req.body;
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  try {
    const result = db.prepare(
      'INSERT INTO users (username, password, full_name, phone, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, bcrypt.hashSync(password, 10), full_name || '', phone || '', 'staff');
    res.status(201).json({
      message: 'Staff account created successfully.',
      user: {
        id: result.lastInsertRowid,
        username,
        full_name: full_name || '',
        phone: phone || '',
        role: 'staff'
      }
    });
  } catch (error) {
    console.error('Staff account creation error:', error);
    res.status(500).json({ error: 'Failed to create staff account.' });
  }
});

app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  const getUsers = db.prepare(`SELECT id, username, full_name, phone, role, created_at FROM users ORDER BY created_at DESC`);
  const users = getUsers.all();
  res.json(users);
});

app.put('/api/admin/users/:userId/role', authenticateToken, isAdmin, [
  body('role').isIn(['customer', 'staff', 'admin']).withMessage('Invalid account role')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const userId = Number(req.params.userId);
  const { role } = req.body;
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID.' });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own account role.' });
  }

  try {
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.role === 'admin' && role !== 'admin' &&
      db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count <= 1) {
      return res.status(400).json({ error: 'The last administrator cannot be demoted.' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    res.json({ message: 'Account role updated successfully.' });
  } catch (error) {
    console.error('Account role update error:', error);
    res.status(500).json({ error: 'Failed to update account role.' });
  }
});

app.put('/api/admin/orders/:orderId/status', authenticateToken, isStaffOrAdmin, (req, res) => {
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
║   💳 Payment provider: ZynlePay (integration required) ║
║   🔐 Authentication: JWT enabled                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});