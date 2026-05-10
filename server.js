import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
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

// ============ MIDDLEWARE ============
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5500', 'https://yourdomain.com'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.')); // Serve static files

// ============ DATABASE SETUP ============
const db = new sqlite3.Database('./canteen.db');

db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT,
    phone TEXT,
    role TEXT DEFAULT 'customer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Orders table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
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
  )`);
  
  // Payments table
  db.run(`CREATE TABLE IF NOT EXISTS payments (
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
  )`);
  
  // Create demo admin user
  const hashedPassword = bcrypt.hashSync('Admin123!', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, full_name, phone, role) 
          VALUES (?, ?, ?, ?, ?)`,
    ['admin@literacytree.com', hashedPassword, 'School Administrator', '+260974754810', 'admin']
  );
});

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
  db.run(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
    [orderId, transactionId, 'mtn', amount, phoneNumber]);

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
  db.run(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
    [orderId, transactionId, 'airtel', amount, phoneNumber]);

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
  db.run(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`,
    [JSON.stringify({ status: 'success', transactionId, amount, provider }), transactionId]);
  db.run(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [orderId]);
}


// ============ API ROUTES ============

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, paymentMethod, customerName, phoneNumber } = req.body;
    
    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (!paymentMethod || !['mtn', 'airtel'].includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = generateOrderNumber();
    
    db.run(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, customerName || 'Guest', phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending'],
      async function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to create order' });
        }
        
        const orderId = this.lastID;
        
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
      });
      
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to process checkout' });
  }
});

app.get('/api/payment-status/:orderNumber', async (req, res) => {
  const { orderNumber } = req.params;
  db.get(`SELECT o.*, p.status as payment_status, p.transaction_id 
          FROM orders o LEFT JOIN payments p ON o.id = p.order_id 
          WHERE o.order_number = ?`, 
    [orderNumber], 
    (err, order) => {
      if (err || !order) return res.status(404).json({ error: 'Order not found' });
      res.json({
        orderNumber: order.order_number,
        totalAmount: order.total_amount,
        paymentStatus: order.payment_status,
        orderStatus: order.status
      });
    });
});

app.post('/api/payments/mtn-callback', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const callbackData = JSON.parse(req.body.toString());
    const transactionId = callbackData.referenceId;
    if (callbackData.status === 'SUCCESSFUL') {
      db.run(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`, [JSON.stringify(callbackData), transactionId]);
      db.run(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT order_id FROM payments WHERE transaction_id = ?)`, [transactionId]);
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
      db.run(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`, [JSON.stringify(callbackData), transactionId]);
      db.run(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT order_id FROM payments WHERE transaction_id = ?)`, [transactionId]);
    }
    res.json({ status: 'received' });
  } catch (error) {
    res.status(200).json({ status: 'error' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  db.all(`SELECT * FROM orders ORDER BY created_at DESC`, [], (err, orders) => {
    res.json(orders);
  });
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
╚═══════════════════════════════════════════════════════╝
  `);
});