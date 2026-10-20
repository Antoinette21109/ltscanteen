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
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import webPush from 'web-push';
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
const BREAK_TIME = process.env.BREAK_TIME || '10:30';
const BREAK_REMINDER_MINUTES = Number(process.env.BREAK_REMINDER_MINUTES || 30);
const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'Africa/Lusaka';
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(BREAK_TIME) ||
  !Number.isInteger(BREAK_REMINDER_MINUTES) || BREAK_REMINDER_MINUTES < 1 || BREAK_REMINDER_MINUTES > 180) {
  throw new Error('BREAK_TIME must be HH:MM and BREAK_REMINDER_MINUTES must be from 1 to 180.');
}

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

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'profile_image_url', 'TEXT');
ensureColumn('orders', 'child_id', 'INTEGER');
ensureColumn('orders', 'child_name', 'TEXT');
ensureColumn('orders', 'scheduled_for', 'TEXT');
ensureColumn('orders', 'receipt_sent_at', 'DATETIME');

const reminderSchedulesExisted = Boolean(db.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminder_schedules'
`).get());

db.exec(`
  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    grade TEXT NOT NULL DEFAULT '',
    photo_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminder_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    push_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminder_deliveries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminder_date TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'push')),
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, reminder_date, channel)
  );

  CREATE TABLE IF NOT EXISTS reminder_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    time TEXT NOT NULL,
    reminder_minutes INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedule_reminder_deliveries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminder_date TEXT NOT NULL,
    schedule_id INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'push')),
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, reminder_date, schedule_id, channel)
  );
`);

if (!reminderSchedulesExisted) {
  const insertReminderSchedule = db.prepare(`
    INSERT INTO reminder_schedules (name, time, reminder_minutes)
    VALUES (?, ?, ?)
  `);
  db.transaction(() => {
    insertReminderSchedule.run('Morning Break', BREAK_TIME, BREAK_REMINDER_MINUTES);
    insertReminderSchedule.run('Lunch', '12:30', BREAK_REMINDER_MINUTES);
  })();
}

const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (userColumns.some((column) => column.name === 'children')) {
  const legacyParents = db.prepare(`
    SELECT id, children FROM users
    WHERE role IN ('customer', 'parent') AND children IS NOT NULL AND children != ''
  `).all();
  const findLegacyChild = db.prepare(`
    SELECT id FROM children WHERE user_id = ? AND lower(name) = lower(?)
  `);
  const addLegacyChild = db.prepare('INSERT INTO children (user_id, name) VALUES (?, ?)');
  db.transaction(() => {
    for (const parent of legacyParents) {
      for (const name of String(parent.children).split(',').map((value) => value.trim()).filter(Boolean)) {
        if (!findLegacyChild.get(parent.id, name)) addLegacyChild.run(parent.id, name.slice(0, 100));
      }
    }
  })();
}

const smtpTransporter = process.env.SMTP_HOST && process.env.SMTP_USER &&
  process.env.SMTP_PASS && process.env.SMTP_FROM
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  })
  : null;
const sendingReceipts = new Set();

const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@literacytree.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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

const isParent = (req, res, next) => {
  if (!['customer', 'parent'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Parent access required.' });
  }
  next();
};

function isValidZambianPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return /^(?:(09|07|096|097|095|076|077)\d{7,8}|260(9|7)\d{7,8})$/.test(digits);
}

function validReminderSchedule(name, time, reminderMinutes) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 60 &&
    typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) &&
    Number.isInteger(Number(reminderMinutes)) && Number(reminderMinutes) >= 1 &&
    Number(reminderMinutes) <= 180 &&
    Number(reminderMinutes) <= Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function cloudinaryProfileSignature(timestamp) {
  const params = `folder=ltscanteen/profiles&timestamp=${timestamp}`;
  return crypto.createHash('sha1').update(`${params}${process.env.CLOUDINARY_API_SECRET}`).digest('hex');
}

function createReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    let items;
    try {
      items = JSON.parse(order.items);
    } catch (error) {
      return reject(new Error(`Order ${order.order_number} has invalid item data.`));
    }

    document.fontSize(20).fillColor('#1a472a').text('Literacy Tree School Canteen', { align: 'center' });
    document.moveDown(0.5).fontSize(12).fillColor('#333333')
      .text(`Receipt for order ${order.order_number}`, { align: 'center' });
    document.moveDown().fontSize(10)
      .text(`Parent: ${order.customer_name}`)
      .text(`Email: ${order.customer_email}`)
      .text(`Order date: ${order.created_at}`)
      .text(`Child: ${order.child_name || 'N/A'}`)
      .text(`Collection date: ${order.scheduled_for || 'As soon as possible'}`)
      .text(`Payment: ${String(order.payment_status).toUpperCase()}`);
    document.moveDown().fontSize(12).text('Items', { underline: true });

    for (const item of items) {
      const quantity = Number(item.quantity || item.qty || 1);
      const price = Number(item.price || 0);
      document.fontSize(10).text(
        `${item.name || item.item || 'Item'} x ${quantity}    ZMW ${(price * quantity).toFixed(2)}`
      );
    }

    document.moveDown().fontSize(13).fillColor('#1a472a')
      .text(`Total: ZMW ${Number(order.total_amount).toFixed(2)}`, { align: 'right' });
    document.moveDown().fontSize(9).fillColor('#666666')
      .text('Thank you for your order.', { align: 'center' });
    document.end();
  });
}

async function sendOrderReceipt(orderId) {
  if (sendingReceipts.has(orderId)) return null;
  sendingReceipts.add(orderId);
  try {
    if (!smtpTransporter) {
      throw new Error('Receipt email is unavailable until SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM are configured.');
    }

    const order = db.prepare(`
      SELECT o.*, u.username AS customer_email
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = ?
    `).get(orderId);
    if (!order) throw new Error('Order or parent email address not found.');
    if (order.payment_status !== 'completed') {
      throw new Error('A receipt can only be emailed after successful payment.');
    }
    if (!order.customer_email) throw new Error('Parent email address is missing.');

    const pdf = await createReceiptPdf(order);
    await smtpTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to: order.customer_email,
      subject: `Receipt for order ${order.order_number}`,
      text: `Hello ${order.customer_name},\n\nYour payment was successful. Your receipt for order ${order.order_number} is attached.`,
      attachments: [{
        filename: `receipt-${order.order_number}.pdf`,
        content: pdf,
        contentType: 'application/pdf'
      }]
    });
    db.prepare('UPDATE orders SET receipt_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(orderId);
    return order.customer_email;
  } finally {
    sendingReceipts.delete(orderId);
  }
}

function getSchoolClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHOOL_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return parts;
}

async function deliverBreakReminders() {
  const clock = getSchoolClock();
  if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return;

  const currentMinutes = Number(clock.hour) * 60 + Number(clock.minute);
  const date = `${clock.year}-${clock.month}-${clock.day}`;
  const schedules = db.prepare(`
    SELECT id, name, time, reminder_minutes FROM reminder_schedules
    WHERE enabled = 1
  `).all();
  const dueSchedules = schedules.filter((schedule) => {
    const [hour, minute] = schedule.time.split(':').map(Number);
    const reminderMinute = hour * 60 + minute - schedule.reminder_minutes;
    return currentMinutes >= reminderMinute && currentMinutes <= reminderMinute + 4;
  });
  if (!dueSchedules.length) return;

  const users = db.prepare(`
    SELECT u.id, u.username, u.full_name, p.email_enabled, p.push_enabled
    FROM reminder_preferences p JOIN users u ON u.id = p.user_id
    WHERE u.role IN ('customer', 'parent')
  `).all();
  const wasDelivered = db.prepare(`
    SELECT 1 FROM schedule_reminder_deliveries
    WHERE user_id = ? AND reminder_date = ? AND schedule_id = ? AND channel = ?
  `);
  const recordDelivery = db.prepare(`
    INSERT OR IGNORE INTO schedule_reminder_deliveries
      (user_id, reminder_date, schedule_id, channel) VALUES (?, ?, ?, ?)
  `);

  for (const schedule of dueSchedules) {
    for (const user of users) {
      if (user.email_enabled && smtpTransporter &&
        !wasDelivered.get(user.id, date, schedule.id, 'email')) {
        try {
          await smtpTransporter.sendMail({
            from: process.env.SMTP_FROM,
            to: user.username,
            subject: `${schedule.name} is coming up`,
            text: `Hello ${user.full_name || 'Parent'}, ${schedule.name.toLowerCase()} starts in ${schedule.reminder_minutes} minutes at ${schedule.time}. You can place a meal order for your child in the Literacy Tree School Canteen.`
          });
          recordDelivery.run(user.id, date, schedule.id, 'email');
        } catch (error) {
          console.error(`${schedule.name} reminder email failed for parent ${user.id}:`, error);
        }
      }

      if (user.push_enabled && vapidConfigured &&
        !wasDelivered.get(user.id, date, schedule.id, 'push')) {
        const subscriptions = db.prepare(
          'SELECT endpoint, subscription_json FROM push_subscriptions WHERE user_id = ?'
        ).all(user.id);
        let delivered = false;
        for (const subscription of subscriptions) {
          try {
            await webPush.sendNotification(JSON.parse(subscription.subscription_json), JSON.stringify({
              title: `${schedule.name} is coming up`,
              body: `${schedule.name} starts in ${schedule.reminder_minutes} minutes at ${schedule.time}. Order a meal for your child.`,
              url: '/'
            }));
            delivered = true;
          } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
              db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
            } else {
              console.error(`${schedule.name} push reminder failed for parent ${user.id}:`, error);
            }
          }
        }
        if (delivered) recordDelivery.run(user.id, date, schedule.id, 'push');
      }
    }
  }
}

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
    const completedOrder = db.prepare('SELECT user_id, receipt_sent_at FROM orders WHERE id = ?').get(orderId);
    if (completedOrder?.user_id && !completedOrder.receipt_sent_at && smtpTransporter) {
      sendOrderReceipt(orderId).catch((error) => {
        console.error(`Receipt email failed for completed order ${orderNumber}:`, error);
      });
    }
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
  const children = typeof req.body.children === 'string'
    ? req.body.children.split(',').map((name) => name.trim()).filter(Boolean)
    : [];

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
    const result = db.transaction(() => {
      const account = insertUser.run(username, hashedPassword, full_name || '', phone || '', 'customer');
      const insertChild = db.prepare('INSERT INTO children (user_id, name) VALUES (?, ?)');
      for (const childName of children.slice(0, 20)) {
        insertChild.run(account.lastInsertRowid, childName.slice(0, 100));
      }
      db.prepare('INSERT OR IGNORE INTO reminder_preferences (user_id) VALUES (?)').run(account.lastInsertRowid);
      return account;
    })();
    
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

app.get('/api/profile', authenticateToken, isParent, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO reminder_preferences (user_id) VALUES (?)').run(req.user.id);
    const user = db.prepare(`
      SELECT id, username, full_name, phone, profile_image_url, role
      FROM users WHERE id = ?
    `).get(req.user.id);
    const children = db.prepare(`
      SELECT id, name, grade, photo_url FROM children
      WHERE user_id = ? ORDER BY id
    `).all(req.user.id);
    const preferences = db.prepare(`
      SELECT email_enabled, push_enabled FROM reminder_preferences WHERE user_id = ?
    `).get(req.user.id);
    res.json({ ...user, children, reminders: preferences });
  } catch (error) {
    console.error('Parent profile fetch error:', error);
    res.status(500).json({ error: 'Unable to load parent profile.' });
  }
});

app.post('/api/profile/upload-signature', authenticateToken, isParent, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Profile photo uploads are not configured. Contact the administrator.' });
  }
  const timestamp = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp,
    folder: 'ltscanteen/profiles',
    signature: cloudinaryProfileSignature(timestamp)
  });
});

function isAllowedProfileImage(imageUrl) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  return Boolean(cloudName) && typeof imageUrl === 'string' && imageUrl.length <= 2000 &&
    /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(imageUrl) &&
    imageUrl.startsWith(`https://res.cloudinary.com/${cloudName}/image/upload/`);
}

app.put('/api/parent-profile', authenticateToken, isParent, [
  body('full_name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('phone').optional().isString().trim().isLength({ max: 30 }),
  body('profile_image_url').optional().isString().isLength({ max: 2000 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const updates = [];
  const params = [];
  if (req.body.full_name !== undefined) {
    updates.push('full_name = ?');
    params.push(req.body.full_name.trim());
  }
  if (req.body.phone !== undefined) {
    updates.push('phone = ?');
    params.push(req.body.phone.trim());
  }
  if (req.body.profile_image_url !== undefined) {
    if (!isAllowedProfileImage(req.body.profile_image_url)) {
      return res.status(400).json({ error: 'Please upload a valid profile photo.' });
    }
    updates.push('profile_image_url = ?');
    params.push(req.body.profile_image_url);
  }
  if (!updates.length) return res.status(400).json({ error: 'No profile fields were provided.' });

  try {
    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ message: 'Profile updated successfully.' });
  } catch (error) {
    console.error('Parent profile update error:', error);
    res.status(500).json({ error: 'Unable to update parent profile.' });
  }
});

app.post('/api/children', authenticateToken, isParent, [
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  body('grade').isString().trim().isLength({ min: 1, max: 50 }),
  body('photo_url').optional().isString().isLength({ max: 2000 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (req.body.photo_url && !isAllowedProfileImage(req.body.photo_url)) {
    return res.status(400).json({ error: 'Please upload a valid child photo.' });
  }
  try {
    const childCount = db.prepare('SELECT COUNT(*) AS count FROM children WHERE user_id = ?').get(req.user.id).count;
    if (childCount >= 20) return res.status(409).json({ error: 'A parent profile can have up to 20 children.' });
    const result = db.prepare(`
      INSERT INTO children (user_id, name, grade, photo_url) VALUES (?, ?, ?, ?)
    `).run(req.user.id, req.body.name.trim(), (req.body.grade || '').trim(), req.body.photo_url || null);
    res.status(201).json({
      id: result.lastInsertRowid,
      name: req.body.name.trim(),
      grade: (req.body.grade || '').trim(),
      photo_url: req.body.photo_url || null
    });
  } catch (error) {
    console.error('Child profile creation error:', error);
    res.status(500).json({ error: 'Unable to add child profile.' });
  }
});

app.put('/api/children/:childId', authenticateToken, isParent, [
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('grade').optional().isString().trim().isLength({ min: 1, max: 50 }),
  body('photo_url').optional().isString().isLength({ max: 2000 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const childId = Number(req.params.childId);
  if (!Number.isInteger(childId) || childId <= 0) return res.status(400).json({ error: 'Invalid child ID.' });
  if (req.body.photo_url && !isAllowedProfileImage(req.body.photo_url)) {
    return res.status(400).json({ error: 'Please upload a valid child photo.' });
  }
  const fields = ['name', 'grade', 'photo_url'].filter((field) => req.body[field] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'No child profile fields were provided.' });
  try {
    const result = db.prepare(`
      UPDATE children SET ${fields.map((field) => `${field} = ?`).join(', ')},
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?
    `).run(...fields.map((field) => {
      const value = req.body[field];
      return field === 'photo_url' ? value : (value || '').trim();
    }), childId, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Child profile not found.' });
    res.json({ message: 'Child profile updated successfully.' });
  } catch (error) {
    console.error('Child profile update error:', error);
    res.status(500).json({ error: 'Unable to update child profile.' });
  }
});

app.delete('/api/children/:childId', authenticateToken, isParent, (req, res) => {
  const childId = Number(req.params.childId);
  if (!Number.isInteger(childId) || childId <= 0) return res.status(400).json({ error: 'Invalid child ID.' });
  const result = db.prepare('DELETE FROM children WHERE id = ? AND user_id = ?').run(childId, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Child profile not found.' });
  res.status(204).end();
});

app.get('/api/push/config', (req, res) => {
  res.json({
    enabled: vapidConfigured,
    publicKey: vapidConfigured ? process.env.VAPID_PUBLIC_KEY : null,
    emailConfigured: Boolean(smtpTransporter),
    schedules: db.prepare(`
      SELECT id, name, time, reminder_minutes FROM reminder_schedules
      WHERE enabled = 1 ORDER BY time, id
    `).all()
  });
});

app.post('/api/push/subscriptions', authenticateToken, isParent, (req, res) => {
  if (!vapidConfigured) return res.status(503).json({ error: 'Browser push notifications are not configured.' });
  const subscription = req.body;
  let endpointHost = '';
  try {
    endpointHost = new URL(subscription?.endpoint).hostname;
  } catch (error) {
    return res.status(400).json({ error: 'Invalid browser push subscription.' });
  }
  const trustedPushHost = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']
    .includes(endpointHost) || endpointHost.endsWith('.notify.windows.com');
  if (!trustedPushHost || typeof subscription?.keys?.p256dh !== 'string' ||
    typeof subscription?.keys?.auth !== 'string') {
    return res.status(400).json({ error: 'Invalid browser push subscription.' });
  }
  try {
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, user_id, subscription_json)
      VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
        subscription_json = excluded.subscription_json
    `).run(subscription.endpoint, req.user.id, JSON.stringify(subscription));
    res.status(201).json({ message: 'Browser notifications enabled.' });
  } catch (error) {
    console.error('Push subscription save error:', error);
    res.status(500).json({ error: 'Unable to enable browser notifications.' });
  }
});

app.delete('/api/push/subscriptions', authenticateToken, isParent, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Push endpoint is required.' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.status(204).end();
});

app.put('/api/reminder-preferences', authenticateToken, isParent, [
  body('email_enabled').isBoolean(),
  body('push_enabled').isBoolean()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (req.body.push_enabled && !vapidConfigured) {
    return res.status(503).json({ error: 'Browser push notifications are not configured.' });
  }
  try {
    db.prepare(`
      INSERT INTO reminder_preferences (user_id, email_enabled, push_enabled, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET email_enabled = excluded.email_enabled,
        push_enabled = excluded.push_enabled, updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, Number(req.body.email_enabled), Number(req.body.push_enabled));
    res.json({ message: 'Reminder preferences saved.' });
  } catch (error) {
    console.error('Reminder preference update error:', error);
    res.status(500).json({ error: 'Unable to save reminder preferences.' });
  }
});

app.get('/api/admin/reminder-schedules', authenticateToken, isAdmin, (req, res) => {
  const schedules = db.prepare(`
    SELECT id, name, time, reminder_minutes, enabled
    FROM reminder_schedules ORDER BY time, id
  `).all();
  res.json(schedules.map((schedule) => ({ ...schedule, enabled: Boolean(schedule.enabled) })));
});

app.post('/api/admin/reminder-schedules', authenticateToken, isAdmin, [
  body('name').isString().trim().isLength({ min: 1, max: 60 }),
  body('time').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('reminder_minutes').isInt({ min: 1, max: 180 }),
  body('enabled').optional().isBoolean()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (!validReminderSchedule(req.body.name, req.body.time, Number(req.body.reminder_minutes))) {
    return res.status(400).json({
      error: 'Reminder lead time must be 1-180 minutes and cannot cross into the previous day.'
    });
  }
  try {
    const result = db.prepare(`
      INSERT INTO reminder_schedules (name, time, reminder_minutes, enabled)
      VALUES (?, ?, ?, ?)
    `).run(req.body.name.trim(), req.body.time, Number(req.body.reminder_minutes),
      req.body.enabled === undefined || req.body.enabled ? 1 : 0);
    res.status(201).json({
      id: result.lastInsertRowid,
      name: req.body.name.trim(),
      time: req.body.time,
      reminder_minutes: Number(req.body.reminder_minutes),
      enabled: req.body.enabled === undefined || Boolean(req.body.enabled)
    });
  } catch (error) {
    console.error('Reminder schedule creation error:', error);
    res.status(500).json({ error: 'Unable to create reminder schedule.' });
  }
});

app.put('/api/admin/reminder-schedules/:scheduleId', authenticateToken, isAdmin, [
  body('name').optional().isString().trim().isLength({ min: 1, max: 60 }),
  body('time').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('reminder_minutes').optional().isInt({ min: 1, max: 180 }),
  body('enabled').optional().isBoolean()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const scheduleId = Number(req.params.scheduleId);
  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    return res.status(400).json({ error: 'Invalid reminder schedule ID.' });
  }

  const fields = [];
  const values = [];
  if (req.body.name !== undefined) {
    fields.push('name = ?');
    values.push(req.body.name.trim());
  }
  if (req.body.time !== undefined) {
    fields.push('time = ?');
    values.push(req.body.time);
  }
  if (req.body.reminder_minutes !== undefined) {
    fields.push('reminder_minutes = ?');
    values.push(Number(req.body.reminder_minutes));
  }
  if (req.body.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(req.body.enabled ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: 'No reminder schedule fields were provided.' });

  try {
    const existing = db.prepare(`
      SELECT name, time, reminder_minutes FROM reminder_schedules WHERE id = ?
    `).get(scheduleId);
    if (!existing) return res.status(404).json({ error: 'Reminder schedule not found.' });
    const nextName = req.body.name === undefined ? existing.name : req.body.name;
    const nextTime = req.body.time === undefined ? existing.time : req.body.time;
    const nextLead = req.body.reminder_minutes === undefined
      ? existing.reminder_minutes : Number(req.body.reminder_minutes);
    if (!validReminderSchedule(nextName, nextTime, nextLead)) {
      return res.status(400).json({
        error: 'Reminder lead time must be 1-180 minutes and cannot cross into the previous day.'
      });
    }
    values.push(scheduleId);
    const result = db.prepare(`
      UPDATE reminder_schedules SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values);
    if (!result.changes) return res.status(404).json({ error: 'Reminder schedule not found.' });
    res.json({ message: 'Reminder schedule updated.' });
  } catch (error) {
    console.error('Reminder schedule update error:', error);
    res.status(500).json({ error: 'Unable to update reminder schedule.' });
  }
});

app.delete('/api/admin/reminder-schedules/:scheduleId', authenticateToken, isAdmin, (req, res) => {
  const scheduleId = Number(req.params.scheduleId);
  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    return res.status(400).json({ error: 'Invalid reminder schedule ID.' });
  }
  const result = db.prepare('DELETE FROM reminder_schedules WHERE id = ?').run(scheduleId);
  if (!result.changes) return res.status(404).json({ error: 'Reminder schedule not found.' });
  res.status(204).end();
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

    if (!isValidZambianPhoneNumber(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

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
    const { items, paymentMethod, phoneNumber, customerName, childId, scheduledFor } = req.body;
    const userId = req.user.id;
    
    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
    
    if (!isValidZambianPhoneNumber(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

    const child = db.prepare('SELECT id, name FROM children WHERE id = ? AND user_id = ?')
      .get(Number(childId), userId);
    if (!child) return res.status(400).json({ error: 'Choose a child from your parent profile.' });
    const today = getSchoolClock();
    const todayString = `${today.year}-${today.month}-${today.day}`;
    const orderDate = typeof scheduledFor === 'string' ? scheduledFor : '';
    const parsedOrderDate = new Date(`${orderDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) ||
      Number.isNaN(parsedOrderDate.getTime()) ||
      parsedOrderDate.toISOString().slice(0, 10) !== orderDate ||
      orderDate < todayString ||
      orderDate > new Date(Date.parse(`${todayString}T00:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Choose an order date between today and 14 days from now.' });
    }

    let order;
    try {
      order = resolveOrderItems(db, items);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const total = order.total;
    const orderNumber = generateOrderNumber();
    
    const insertOrder = db.prepare(`INSERT INTO orders
      (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method,
       payment_status, msisdn, status, child_id, child_name, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(
      orderNumber, userId, customerName || req.user.username, phoneNumber,
      JSON.stringify(order.items), total, paymentMethod, 'pending', phoneNumber, 'pending',
      child.id, child.name, orderDate
    );
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
    
    if (!isValidZambianPhoneNumber(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });
    
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

  if (order.payment_status === 'completed' && !order.receipt_sent_at && smtpTransporter) {
    sendOrderReceipt(order.id).catch((error) => {
      console.error(`Receipt email failed for order ${order.order_number}:`, error);
    });
  }

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
      const completedOrder = db.transaction(() => {
        const payment = db.prepare(`
          SELECT order_id FROM payments WHERE transaction_id = ? OR reference = ?
        `).get(transactionId, transactionId);
        if (!payment) return null;
        db.prepare(`
          UPDATE payments SET status = 'completed', callback_data = ?
          WHERE transaction_id = ? OR reference = ?
        `).run(JSON.stringify(callbackData), transactionId, transactionId);
        db.prepare(`
          UPDATE orders SET payment_status = 'completed', status = 'confirmed',
            updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(payment.order_id);
        return db.prepare('SELECT id, receipt_sent_at FROM orders WHERE id = ?').get(payment.order_id);
      })();
      if (completedOrder && !completedOrder.receipt_sent_at && smtpTransporter) {
        sendOrderReceipt(completedOrder.id).catch((error) => {
          console.error(`Receipt email failed for completed order ${completedOrder.id}:`, error);
        });
      }
    }

    res.json({ status: 'received' });
  } catch (error) {
    console.error('Zynle payment callback processing error:', error);
    res.status(500).json({ error: 'Payment callback processing failed.' });
  }
});

// Get user's orders
app.get(['/api/my-orders', '/api/orders'], authenticateToken, (req, res) => {
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
  const getOrders = db.prepare(`
    SELECT o.*, CASE WHEN ? = 'admin' THEN u.username ELSE NULL END AS customer_email
    FROM orders o LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC
  `);
  const orders = getOrders.all(req.user.role);
  res.json(orders);
});

app.post('/api/admin/orders/:orderId/resend-receipt', authenticateToken, isAdmin, async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order ID.' });
  }
  const order = db.prepare('SELECT order_number, payment_status FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.payment_status !== 'completed') {
    return res.status(409).json({ error: 'Only successfully paid orders can receive a receipt.' });
  }
  try {
    const email = await sendOrderReceipt(orderId);
    res.json({ message: 'Receipt resent successfully.', email });
  } catch (error) {
    console.error(`Admin receipt resend failed for order ${order.order_number}:`, error);
    res.status(smtpTransporter ? 502 : 503).json({ error: error.message || 'Unable to resend receipt.' });
  }
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

if (!smtpTransporter) {
  console.warn('SMTP is not configured; order receipts and email reminders are disabled.');
}
if (!vapidConfigured) {
  console.warn('VAPID keys are not configured; browser push reminders are disabled.');
}

let reminderCheckRunning = false;
const reminderInterval = setInterval(async () => {
  if (reminderCheckRunning) return;
  reminderCheckRunning = true;
  try {
    await deliverBreakReminders();
  } catch (error) {
    console.error('Break reminder scheduler failed:', error);
  } finally {
    reminderCheckRunning = false;
  }
}, 60 * 1000);
reminderInterval.unref();
deliverBreakReminders().catch((error) => {
  console.error('Initial break reminder check failed:', error);
});