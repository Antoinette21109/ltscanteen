import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import webPush from 'web-push';
import { body, validationResult } from 'express-validator';
import { getFirebaseServices } from './backend/src/config/firebaseAdmin.js';
import {
  createCloudinaryUploadSignature,
  defaultMenuItems,
  formatMenuItem,
  validateMenuItem
} from './backend/src/config/menu.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'Africa/Lusaka';
const ADMIN_EMAILS = new Set((process.env.FIREBASE_ADMIN_EMAILS || '')
  .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5500',
    'https://ltscanteen.vercel.app',
    'https://ltscanteen-81tsl2fb2-antoinette21109s-projects.vercel.app',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

function services() {
  return getFirebaseServices();
}

function collection(name) {
  return services().firestore.collection(name);
}

function asPublicDocument(snapshot) {
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

function timestamp() {
  return new Date().toISOString();
}

function failure(res, error, message, status = 500) {
  console.error(message, error);
  return res.status(status).json({ error: message });
}

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

async function nextSequence(name) {
  const { firestore } = services();
  const ref = firestore.collection('system').doc(`counters_${name}`);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const next = Number(snapshot.data()?.value || 0) + 1;
    transaction.set(ref, { value: next }, { merge: true });
    return next;
  });
}

async function initializeFirebaseData() {
  const menu = await collection('menuItems').limit(1).get();
  if (menu.empty) {
    const { firestore } = services();
    const batch = firestore.batch();
    for (const item of defaultMenuItems) {
      batch.set(collection('menuItems').doc(String(item.id)), {
        ...item,
        is_available: true,
        promo_percent: null,
        promo_start: null,
        promo_end: null,
        created_at: timestamp(),
        updated_at: timestamp()
      });
    }
    batch.set(firestore.collection('system').doc('counters_menuItems'), { value: defaultMenuItems.length });
    await batch.commit();
  }

  const schedules = await collection('reminderSchedules').limit(1).get();
  if (schedules.empty) {
    const { firestore } = services();
    const batch = firestore.batch();
    const configuredTime = process.env.BREAK_TIME || '10:30';
    const leadMinutes = Number(process.env.BREAK_REMINDER_MINUTES || 30);
    batch.set(collection('reminderSchedules').doc('morning-break'), {
      name: 'Morning Break',
      time: configuredTime,
      reminder_minutes: leadMinutes,
      enabled: true,
      created_at: timestamp(),
      updated_at: timestamp()
    });
    batch.set(collection('reminderSchedules').doc('lunch'), {
      name: 'Lunch',
      time: '12:30',
      reminder_minutes: leadMinutes,
      enabled: true,
      created_at: timestamp(),
      updated_at: timestamp()
    });
    await batch.commit();
  }
}

async function ensureUserProfile(firebaseUser) {
  const profileRef = collection('users').doc(firebaseUser.uid);
  const snapshot = await profileRef.get();
  const isConfiguredAdmin = ADMIN_EMAILS.has(String(firebaseUser.email || '').toLowerCase());
  if (!snapshot.exists) {
    const profile = {
      email: firebaseUser.email || '',
      full_name: firebaseUser.displayName || '',
      phone: '',
      profile_image_url: '',
      role: isConfiguredAdmin ? 'admin' : 'customer',
      reminder_preferences: { email_enabled: false, push_enabled: false },
      created_at: timestamp(),
      updated_at: timestamp()
    };
    await profileRef.create(profile);
    return { ...profile, id: firebaseUser.uid };
  }

  const profile = snapshot.data();
  if (isConfiguredAdmin && profile.role !== 'admin') {
    await profileRef.update({ role: 'admin', updated_at: timestamp() });
    return { ...profile, id: firebaseUser.uid, role: 'admin' };
  }
  return { ...profile, id: firebaseUser.uid };
}

const authenticateToken = async (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    const { auth } = services();
    const firebaseUser = await auth.verifyIdToken(token);
    const profile = await ensureUserProfile(firebaseUser);
    req.user = {
      id: firebaseUser.uid,
      firebaseUid: firebaseUser.uid,
      username: firebaseUser.email || '',
      full_name: profile.full_name || firebaseUser.displayName || '',
      phone: profile.phone || '',
      role: profile.role || 'customer',
      authSessionId: firebaseUser.uid
    };
    req.firebaseProfile = profile;
    next();
  } catch (error) {
    if (error.code === 'firebase/configuration-missing') {
      return res.status(503).json({ error: 'Firebase authentication is not configured on the server.' });
    }
    console.error('Firebase authentication failed:', error);
    res.status(401).json({ error: 'Invalid or expired Firebase token.' });
  }
};

function isAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function isStaffOrAdmin(req, res, next) {
  if (!['staff', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Staff access required.' });
  next();
}

function isParent(req, res, next) {
  if (!['customer', 'parent'].includes(req.user.role)) return res.status(403).json({ error: 'Parent access required.' });
  next();
}

function validReminderSchedule(name, time, reminderMinutes) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 60 &&
    typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) &&
    Number.isInteger(Number(reminderMinutes)) && Number(reminderMinutes) >= 1 &&
    Number(reminderMinutes) <= 180 &&
    Number(reminderMinutes) <= Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function isValidZambianPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return /^(?:(09|07|096|097|095|076|077)\d{7,8}|260(9|7)\d{7,8})$/.test(digits);
}

function cloudinaryProfileSignature(timestampValue) {
  const params = `folder=ltscanteen/profiles&timestamp=${timestampValue}`;
  return crypto.createHash('sha1')
    .update(`${params}${process.env.CLOUDINARY_API_SECRET}`).digest('hex');
}

function isAllowedProfileImage(imageUrl) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  return Boolean(cloudName) && typeof imageUrl === 'string' && imageUrl.length <= 2000 &&
    imageUrl.startsWith(`https://res.cloudinary.com/${cloudName}/image/upload/`);
}

function parseOrderItems(order) {
  return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
}

async function getMenuItems(includeUnavailable = true) {
  const snapshot = await collection('menuItems').get();
  return snapshot.docs.map((doc) => ({ id: Number(doc.id), ...doc.data() }))
    .filter((item) => includeUnavailable || item.is_available)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

async function resolveOrderItems(requestedItems) {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0 || requestedItems.length > 50) {
    throw new Error('Please provide between 1 and 50 menu items.');
  }
  const menuItems = new Map((await getMenuItems()).map((item) => [Number(item.id), item]));
  const items = requestedItems.map((requested) => {
    const id = Number(requested?.id);
    const quantity = Number(requested?.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new Error('Each menu item must have a valid ID and quantity.');
    }
    const menuItem = menuItems.get(id);
    if (!menuItem) throw new Error('A selected menu item no longer exists.');
    if (!menuItem.is_available) throw new Error(`${menuItem.name} is currently out of stock.`);
    const formatted = formatMenuItem(menuItem);
    return { id, name: menuItem.name, price: formatted.price, quantity };
  });
  return {
    items,
    total: Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100
  };
}

function generateOrderNumber() {
  const date = new Date();
  const datePart = date.toISOString().replace(/\D/g, '').slice(0, 14);
  return `LTS-${datePart}-${crypto.randomInt(100, 1000)}`;
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

function createReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.fontSize(20).fillColor('#1a472a').text('Literacy Tree School Canteen', { align: 'center' });
    document.moveDown(0.5).fontSize(12).fillColor('#333333')
      .text(`Receipt for order ${order.order_number}`, { align: 'center' });
    document.moveDown().fontSize(10)
      .text(`Parent: ${order.customer_name}`)
      .text(`Email: ${order.customer_email || ''}`)
      .text(`Order date: ${order.created_at}`)
      .text(`Child: ${order.child_name || 'N/A'}`)
      .text(`Collection date: ${order.scheduled_for || 'As soon as possible'}`)
      .text(`Payment: ${String(order.payment_status).toUpperCase()}`);
    document.moveDown().fontSize(12).text('Items', { underline: true });
    for (const item of parseOrderItems(order)) {
      document.fontSize(10).text(`${item.name} x ${item.quantity}    ZMW ${(item.price * item.quantity).toFixed(2)}`);
    }
    document.moveDown().fontSize(13).fillColor('#1a472a')
      .text(`Total: ZMW ${Number(order.total_amount).toFixed(2)}`, { align: 'right' });
    document.moveDown().fontSize(9).fillColor('#666666')
      .text('Thank you for your order.', { align: 'center' });
    document.end();
  });
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

async function sendOrderReceipt(orderId) {
  if (!smtpTransporter || sendingReceipts.has(orderId)) return null;
  sendingReceipts.add(orderId);
  try {
    const snapshot = await collection('orders').doc(String(orderId)).get();
    const order = asPublicDocument(snapshot);
    if (!order || order.payment_status !== 'completed') {
      throw new Error('A receipt can only be emailed after successful payment.');
    }
    const customer = await collection('users').doc(order.user_id).get();
    const customerEmail = customer.data()?.email;
    if (!customerEmail) throw new Error('Parent email address is missing.');
    const pdf = await createReceiptPdf({ ...order, customer_email: customerEmail });
    await smtpTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to: customerEmail,
      subject: `Receipt for order ${order.order_number}`,
      text: `Hello ${order.customer_name},\n\nYour payment was successful. Your receipt for order ${order.order_number} is attached.`,
      attachments: [{ filename: `receipt-${order.order_number}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });
    await snapshot.ref.update({ receipt_sent_at: timestamp() });
    return customerEmail;
  } finally {
    sendingReceipts.delete(orderId);
  }
}

async function initiateZynlePayment(order, orderRef) {
  const transactionId = crypto.randomUUID();
  const paymentRef = collection('payments').doc(transactionId);
  const payment = {
    order_id: orderRef.id,
    order_number: order.order_number,
    transaction_id: transactionId,
    provider: 'zynle',
    amount: order.total_amount,
    phone_number: order.customer_phone,
    status: 'pending',
    created_at: timestamp()
  };
  await paymentRef.set(payment);
  await orderRef.update({ transaction_id: transactionId });

  const zynleUrl = process.env.ZYNLE_API_URL;
  const zynleKey = process.env.ZYNLE_API_KEY;
  if (zynleUrl && zynleKey) {
    const baseUrl = zynleUrl.replace(/\/$/, '');
    const callbackUrl = process.env.ZYNLE_CALLBACK_URL ||
      `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/api/payments/zynle-callback`;
    const payload = {
      merchantId: process.env.ZYNLE_MERCHANT_ID,
      merchant_id: process.env.ZYNLE_MERCHANT_ID,
      amount: Number(order.total_amount).toFixed(2),
      currency: process.env.CURRENCY || 'ZMW',
      orderId: order.order_number,
      order_id: order.order_number,
      externalId: order.order_number,
      external_id: order.order_number,
      phoneNumber: order.customer_phone.replace(/\D/g, ''),
      customerPhone: order.customer_phone.replace(/\D/g, ''),
      callbackUrl,
      callback_url: callbackUrl,
      metadata: { orderId: orderRef.id, orderNumber: order.order_number, transactionId, provider: 'zynle' }
    };
    const endpoints = [
      `${baseUrl}/payments/initiate`,
      `${baseUrl}/api/payments/initiate`,
      `${baseUrl}/payment/initiate`,
      `${baseUrl}/initiate-payment`
    ];
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(endpoint, payload, {
          headers: { Authorization: `Bearer ${zynleKey}`, 'Content-Type': 'application/json', 'X-API-Key': zynleKey },
          timeout: 20000
        });
        const reference = response.data?.reference || response.data?.transactionId ||
          response.data?.paymentId || response.data?.data?.reference || transactionId;
        await paymentRef.update({ reference });
        return {
          transactionId: reference,
          status: 'pending',
          message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
        };
      } catch (error) {
        lastError = error;
        if (error.response?.status !== 404 && error.response?.status !== 405) {
          throw new Error(error.response?.data?.message || error.message || 'Zynle payment initiation failed.');
        }
      }
    }
    throw new Error(lastError?.response?.data?.message ||
      'ZynlePay API endpoint is not reachable using the configured credentials.');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('ZynlePay API credentials are not configured.');
  }
  setTimeout(async () => {
    try {
      await markPaymentCompleted(transactionId, { status: 'success', provider: 'local-test' });
    } catch (error) {
      console.error(`Local test payment completion failed for ${order.order_number}:`, error);
    }
  }, 3000);
  return {
    transactionId,
    status: 'pending',
    message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
  };
}

async function markPaymentCompleted(transactionId, callbackData) {
  const paymentRef = collection('payments').doc(String(transactionId));
  const paymentSnapshot = await paymentRef.get();
  if (!paymentSnapshot.exists) {
    const query = await collection('payments').where('reference', '==', String(transactionId)).limit(1).get();
    if (query.empty) return null;
    return completePaymentDocument(query.docs[0], callbackData);
  }
  return completePaymentDocument(paymentSnapshot, callbackData);
}

async function completePaymentDocument(paymentSnapshot, callbackData) {
  const payment = paymentSnapshot.data();
  const orderRef = collection('orders').doc(payment.order_id);
  await services().firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) throw new Error('Order associated with payment was not found.');
    transaction.update(paymentSnapshot.ref, {
      status: 'completed',
      callback_data: callbackData,
      updated_at: timestamp()
    });
    transaction.update(orderRef, {
      payment_status: 'completed',
      status: 'confirmed',
      updated_at: timestamp()
    });
  });
  const order = await orderRef.get();
  if (order.exists && !order.data().receipt_sent_at && smtpTransporter) {
    sendOrderReceipt(order.id).catch((error) => console.error(`Receipt email failed for ${order.id}:`, error));
  }
  return order;
}

async function createOrder({ items, paymentMethod, phoneNumber, customerName, userId, childId, scheduledFor }) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('No items in cart'), { status: 400 });
  if (paymentMethod !== 'zynle') throw Object.assign(new Error('Only ZynlePay is supported'), { status: 400 });
  if (!isValidZambianPhoneNumber(phoneNumber)) throw Object.assign(new Error('Invalid Zambian phone number'), { status: 400 });

  let child = null;
  if (userId && childId) {
    const childSnapshot = await collection('users').doc(userId).collection('children').doc(String(childId)).get();
    child = asPublicDocument(childSnapshot);
  }
  if (userId && (!child || !scheduledFor)) {
    throw Object.assign(new Error('Choose a child and collection date from your parent profile.'), { status: 400 });
  }
  if (userId) {
    const today = getSchoolClock();
    const todayString = `${today.year}-${today.month}-${today.day}`;
    const parsed = new Date(`${scheduledFor}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor) || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== scheduledFor || scheduledFor < todayString ||
      scheduledFor > new Date(Date.parse(`${todayString}T00:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10)) {
      throw Object.assign(new Error('Choose an order date between today and 14 days from now.'), { status: 400 });
    }
  }
  const resolved = await resolveOrderItems(items);
  const orderNumber = generateOrderNumber();
  const orderRef = collection('orders').doc();
  const order = {
    order_number: orderNumber,
    user_id: userId || null,
    customer_name: customerName || 'Guest',
    customer_phone: phoneNumber,
    items: JSON.stringify(resolved.items),
    total_amount: resolved.total,
    payment_method: paymentMethod,
    payment_status: 'pending',
    transaction_id: null,
    msisdn: phoneNumber,
    status: 'pending',
    child_id: child?.id || null,
    child_name: child?.name || '',
    scheduled_for: scheduledFor || null,
    created_at: timestamp(),
    updated_at: timestamp()
  };
  await orderRef.set(order);
  try {
    const payment = await initiateZynlePayment(order, orderRef);
    return { success: true, orderNumber, transactionId: payment.transactionId, paymentStatus: payment.status, message: payment.message };
  } catch (error) {
    await orderRef.delete();
    throw error;
  }
}

app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: timestamp(), storage: 'firebase-firestore' }));

app.get('/api/menu', async (req, res) => {
  try {
    res.json((await getMenuItems()).map((item) => formatMenuItem(item)));
  } catch (error) {
    failure(res, error, 'Unable to load the menu.');
  }
});

app.post('/api/register', [
  authenticateToken,
  isParent,
  body('full_name').isString().trim().isLength({ min: 1, max: 100 }),
  body('phone').optional().isString().trim().isLength({ max: 30 }),
  body('children').optional().isString().isLength({ max: 3000 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  const children = typeof req.body.children === 'string'
    ? req.body.children.split(',').map((name) => name.trim()).filter(Boolean).slice(0, 20)
    : [];
  try {
    const { firestore } = services();
    const profileRef = collection('users').doc(req.user.id);
    const update = {
      email: req.user.username,
      full_name: req.body.full_name.trim(),
      phone: (req.body.phone || '').trim(),
      role: 'customer',
      updated_at: timestamp()
    };
    await profileRef.set(update, { merge: true });
    const batch = firestore.batch();
    for (const name of children) {
      const childRef = profileRef.collection('children').doc();
      batch.set(childRef, {
        id: childRef.id,
        name: name.slice(0, 100),
        grade: '',
        photo_url: null,
        created_at: timestamp(),
        updated_at: timestamp()
      });
    }
    await batch.commit();
    res.status(201).json({
      message: 'User registered successfully',
      token: req.headers.authorization.slice(7),
      user: { id: req.user.id, username: req.user.username, ...update }
    });
  } catch (error) {
    failure(res, error, 'Registration failed');
  }
});

app.post('/api/login', (req, res) => res.status(401).json({
  error: 'Sign in through Firebase Authentication and retry.'
}));

app.get('/api/me', authenticateToken, async (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    full_name: req.user.full_name,
    phone: req.user.phone,
    role: req.user.role,
    created_at: req.firebaseProfile.created_at || null
  });
});

app.get('/api/profile', authenticateToken, isParent, async (req, res) => {
  try {
    const profileRef = collection('users').doc(req.user.id);
    const [profileSnapshot, childrenSnapshot] = await Promise.all([
      profileRef.get(),
      profileRef.collection('children').get()
    ]);
    const profile = profileSnapshot.data() || {};
    const preferences = profile.reminder_preferences || { email_enabled: false, push_enabled: false };
    res.json({
      id: req.user.id,
      username: req.user.username,
      full_name: profile.full_name || '',
      phone: profile.phone || '',
      profile_image_url: profile.profile_image_url || '',
      role: req.user.role,
      children: childrenSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      reminders: {
        email_enabled: Number(preferences.email_enabled),
        push_enabled: Number(preferences.push_enabled)
      }
    });
  } catch (error) {
    failure(res, error, 'Unable to load parent profile.');
  }
});

app.post('/api/profile/upload-signature', authenticateToken, isParent, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Profile photo uploads are not configured. Contact the administrator.' });
  }
  const uploadTime = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp: uploadTime,
    folder: 'ltscanteen/profiles',
    signature: cloudinaryProfileSignature(uploadTime)
  });
});

app.put('/api/parent-profile', authenticateToken, isParent, [
  body('full_name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('phone').optional().isString().trim().isLength({ max: 30 }),
  body('profile_image_url').optional().isString().isLength({ max: 2000 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  const updates = { updated_at: timestamp() };
  if (req.body.full_name !== undefined) updates.full_name = req.body.full_name.trim();
  if (req.body.phone !== undefined) updates.phone = req.body.phone.trim();
  if (req.body.profile_image_url !== undefined) {
    if (!isAllowedProfileImage(req.body.profile_image_url)) return res.status(400).json({ error: 'Please upload a valid profile photo.' });
    updates.profile_image_url = req.body.profile_image_url;
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'No profile fields were provided.' });
  try {
    await collection('users').doc(req.user.id).set(updates, { merge: true });
    res.json({ message: 'Profile updated successfully.' });
  } catch (error) {
    failure(res, error, 'Unable to update parent profile.');
  }
});

app.post('/api/children', authenticateToken, isParent, [
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  body('grade').isString().trim().isLength({ min: 1, max: 50 }),
  body('photo_url').optional().isString().isLength({ max: 2000 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (req.body.photo_url && !isAllowedProfileImage(req.body.photo_url)) return res.status(400).json({ error: 'Please upload a valid child photo.' });
  try {
    const children = collection('users').doc(req.user.id).collection('children');
    const snapshot = await children.get();
    if (snapshot.size >= 20) return res.status(409).json({ error: 'A parent profile can have up to 20 children.' });
    const childRef = children.doc();
    const child = {
      id: childRef.id,
      name: req.body.name.trim(),
      grade: req.body.grade.trim(),
      photo_url: req.body.photo_url || null,
      created_at: timestamp(),
      updated_at: timestamp()
    };
    await childRef.set(child);
    res.status(201).json(child);
  } catch (error) {
    failure(res, error, 'Unable to add child profile.');
  }
});

app.put('/api/children/:childId', authenticateToken, isParent, [
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('grade').optional().isString().trim().isLength({ min: 1, max: 50 }),
  body('photo_url').optional().isString().isLength({ max: 2000 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (req.body.photo_url && !isAllowedProfileImage(req.body.photo_url)) return res.status(400).json({ error: 'Please upload a valid child photo.' });
  const updates = { updated_at: timestamp() };
  for (const field of ['name', 'grade', 'photo_url']) {
    if (req.body[field] !== undefined) updates[field] = field === 'photo_url' ? req.body[field] : req.body[field].trim();
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'No child profile fields were provided.' });
  try {
    const ref = collection('users').doc(req.user.id).collection('children').doc(req.params.childId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Child profile not found.' });
    await ref.update(updates);
    res.json({ message: 'Child profile updated successfully.' });
  } catch (error) {
    failure(res, error, 'Unable to update child profile.');
  }
});

app.delete('/api/children/:childId', authenticateToken, isParent, async (req, res) => {
  try {
    const ref = collection('users').doc(req.user.id).collection('children').doc(req.params.childId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Child profile not found.' });
    await ref.delete();
    res.status(204).end();
  } catch (error) {
    failure(res, error, 'Unable to remove child profile.');
  }
});

const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@literacytree.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

app.get('/api/push/config', async (req, res) => {
  try {
    const snapshot = await collection('reminderSchedules').where('enabled', '==', true).get();
    res.json({
      enabled: vapidConfigured,
      publicKey: vapidConfigured ? process.env.VAPID_PUBLIC_KEY : null,
      emailConfigured: Boolean(smtpTransporter),
      schedules: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => a.time.localeCompare(b.time))
    });
  } catch (error) {
    failure(res, error, 'Unable to load reminder configuration.');
  }
});

app.post('/api/push/subscriptions', authenticateToken, isParent, async (req, res) => {
  if (!vapidConfigured) return res.status(503).json({ error: 'Browser push notifications are not configured.' });
  const subscription = req.body;
  let endpointHost;
  try {
    endpointHost = new URL(subscription?.endpoint).hostname;
  } catch {
    return res.status(400).json({ error: 'Invalid browser push subscription.' });
  }
  const trusted = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']
    .includes(endpointHost) || endpointHost.endsWith('.notify.windows.com');
  if (!trusted || typeof subscription?.keys?.p256dh !== 'string' || typeof subscription?.keys?.auth !== 'string') {
    return res.status(400).json({ error: 'Invalid browser push subscription.' });
  }
  try {
    const key = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
    await collection('users').doc(req.user.id).collection('pushSubscriptions').doc(key)
      .set({ ...subscription, created_at: timestamp() });
    res.status(201).json({ message: 'Browser notifications enabled.' });
  } catch (error) {
    failure(res, error, 'Unable to enable browser notifications.');
  }
});

app.delete('/api/push/subscriptions', authenticateToken, isParent, async (req, res) => {
  if (typeof req.body?.endpoint !== 'string') return res.status(400).json({ error: 'Push endpoint is required.' });
  const key = crypto.createHash('sha256').update(req.body.endpoint).digest('hex');
  await collection('users').doc(req.user.id).collection('pushSubscriptions').doc(key).delete();
  res.status(204).end();
});

app.put('/api/reminder-preferences', authenticateToken, isParent, [
  body('email_enabled').isBoolean(),
  body('push_enabled').isBoolean()
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (req.body.push_enabled && !vapidConfigured) return res.status(503).json({ error: 'Browser push notifications are not configured.' });
  try {
    await collection('users').doc(req.user.id).set({
      reminder_preferences: {
        email_enabled: Boolean(req.body.email_enabled),
        push_enabled: Boolean(req.body.push_enabled)
      },
      updated_at: timestamp()
    }, { merge: true });
    res.json({ message: 'Reminder preferences saved.' });
  } catch (error) {
    failure(res, error, 'Unable to save reminder preferences.');
  }
});

app.put('/api/profile', authenticateToken, [
  body('full_name').optional().isString().trim().isLength({ max: 100 }),
  body('phone').optional().isString().trim().isLength({ max: 30 }),
  body('currentPassword').optional().isString(),
  body('newPassword').optional().isLength({ min: 6 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (req.body.newPassword) {
    try {
      const { auth } = services();
      const user = await auth.getUser(req.user.id);
      await auth.updateUser(req.user.id, { password: req.body.newPassword });
      if (!user.email) return res.status(400).json({ error: 'Account email is missing.' });
    } catch (error) {
      return failure(res, error, 'Unable to update password.');
    }
  }
  const updates = { updated_at: timestamp() };
  if (req.body.full_name !== undefined) updates.full_name = req.body.full_name.trim();
  if (req.body.phone !== undefined) updates.phone = req.body.phone.trim();
  if (Object.keys(updates).length === 1 && !req.body.newPassword) return res.status(400).json({ error: 'No fields to update' });
  try {
    if (Object.keys(updates).length > 1) await collection('users').doc(req.user.id).set(updates, { merge: true });
    const profile = { ...req.firebaseProfile, ...updates };
    res.json({
      message: 'Profile updated successfully',
      user: { id: req.user.id, username: req.user.username, full_name: profile.full_name || '', phone: profile.phone || '', role: req.user.role }
    });
  } catch (error) {
    failure(res, error, 'Failed to update profile');
  }
});

app.get('/api/menu/access', authenticateToken, isStaffOrAdmin, async (req, res) => {
  if (req.user.role === 'admin') return res.json({ status: 'approved', admin: true });
  try {
    const ref = collection('menuAccessRequests').doc(`${req.user.id}_${req.user.authSessionId}`);
    const snapshot = await ref.get();
    res.json(snapshot.exists ? snapshot.data() : { status: 'not_requested' });
  } catch (error) {
    failure(res, error, 'Unable to check menu access.');
  }
});

app.post('/api/menu/access-requests', authenticateToken, isStaffOrAdmin, async (req, res) => {
  if (req.user.role === 'admin') return res.json({ status: 'approved', admin: true });
  try {
    const ref = collection('menuAccessRequests').doc(`${req.user.id}_${req.user.authSessionId}`);
    const current = await ref.get();
    if (current.exists && ['approved', 'pending'].includes(current.data().status)) {
      return res.json({ status: current.data().status });
    }
    await ref.set({
      user_id: req.user.id,
      session_id: req.user.authSessionId,
      status: 'pending',
      requested_at: timestamp(),
      reviewed_by: null,
      reviewed_at: null
    });
    res.status(201).json({ status: 'pending' });
  } catch (error) {
    failure(res, error, 'Unable to request menu access.');
  }
});

async function requireMenuAccess(req, res, next) {
  if (req.user.role === 'admin') return next();
  try {
    const request = await collection('menuAccessRequests')
      .doc(`${req.user.id}_${req.user.authSessionId}`).get();
    if (request.data()?.status !== 'approved') {
      return res.status(403).json({ error: 'Administrator approval is required for menu controls in this session.' });
    }
    next();
  } catch (error) {
    failure(res, error, 'Unable to verify menu access.');
  }
}

app.post(['/api/menu/upload-signature', '/api/admin/menu/upload-signature'],
  authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Image uploads are not configured. Contact the administrator.' });
  }
  const uploadTime = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp: uploadTime,
    folder: 'ltscanteen/menu',
    signature: createCloudinaryUploadSignature(CLOUDINARY_API_SECRET, uploadTime)
  });
});

app.get('/api/menu/changes/mine', authenticateToken, isStaffOrAdmin, async (req, res) => {
  try {
    const snapshot = await collection('menuChangeRequests').where('user_id', '==', req.user.id).get();
    res.json(snapshot.docs.map(asPublicDocument).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50));
  } catch (error) {
    failure(res, error, 'Unable to load your menu changes.');
  }
});

app.post('/api/menu/changes', authenticateToken, isStaffOrAdmin, requireMenuAccess, async (req, res) => {
  const itemId = req.body.itemId == null || req.body.itemId === '' ? null : Number(req.body.itemId);
  if (itemId !== null && (!Number.isInteger(itemId) || itemId <= 0)) return res.status(400).json({ error: 'Invalid menu item ID.' });
  let payload;
  try {
    payload = validateMenuItem(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const { firestore } = services();
    const menuRef = collection('menuItems');
    if (itemId !== null && !(await menuRef.doc(String(itemId)).get()).exists) {
      return res.status(404).json({ error: 'Menu item not found.' });
    }
    if (req.user.role === 'admin') {
      const id = itemId ?? await nextSequence('menuItems');
      const ref = menuRef.doc(String(id));
      await ref.set({ ...payload, created_at: timestamp(), updated_at: timestamp() }, { merge: true });
      return res.status(itemId === null ? 201 : 200).json({
        status: 'approved',
        item: formatMenuItem({ id, ...payload })
      });
    }
    const ref = collection('menuChangeRequests').doc();
    await ref.set({
      id: ref.id,
      user_id: req.user.id,
      session_id: req.user.authSessionId,
      full_name: req.user.full_name,
      username: req.user.username,
      item_id: itemId,
      action: itemId === null ? 'create' : 'update',
      payload,
      status: 'pending',
      review_note: null,
      created_at: timestamp()
    });
    res.status(202).json({ status: 'pending', requestId: ref.id });
  } catch (error) {
    failure(res, error, 'Unable to submit menu change for review.');
  }
});

app.get('/api/admin/menu/access-requests', authenticateToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await collection('menuAccessRequests').where('status', '==', 'pending').get();
    res.json(snapshot.docs.map(asPublicDocument).sort((a, b) => a.requested_at.localeCompare(b.requested_at)));
  } catch (error) {
    failure(res, error, 'Unable to load menu access requests.');
  }
});

app.put('/api/admin/menu/access-requests/:requestId', authenticateToken, isAdmin, [
  body('decision').isIn(['approved', 'denied'])
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const ref = collection('menuAccessRequests').doc(req.params.requestId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().status !== 'pending') return res.status(404).json({ error: 'Pending access request not found.' });
    await ref.update({ status: req.body.decision, reviewed_by: req.user.id, reviewed_at: timestamp() });
    res.json({ status: req.body.decision });
  } catch (error) {
    failure(res, error, 'Unable to review menu access request.');
  }
});

app.get('/api/admin/menu/changes', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [changes, items] = await Promise.all([
      collection('menuChangeRequests').where('status', '==', 'pending').get(),
      collection('menuItems').get()
    ]);
    const menu = new Map(items.docs.map((doc) => [doc.id, doc.data()]));
    res.json(changes.docs.map((doc) => {
      const change = asPublicDocument(doc);
      const current = menu.get(String(change.item_id)) || {};
      return {
        ...change,
        current_name: current.name || null,
        current_price: current.price ?? null,
        current_description: current.description || null,
        current_image_url: current.image_url || null,
        current_is_available: current.is_available ?? null
      };
    }).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  } catch (error) {
    failure(res, error, 'Unable to load menu review queue.');
  }
});

app.put('/api/admin/menu/changes/:changeId/review', authenticateToken, isAdmin, [
  body('decision').isIn(['approved', 'denied']),
  body('reviewNote').optional().isString().isLength({ max: 500 })
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const { firestore } = services();
    const ref = collection('menuChangeRequests').doc(req.params.changeId);
    const review = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data().status !== 'pending') return false;
      const change = snapshot.data();
      if (req.body.decision === 'approved') {
        const payload = validateMenuItem(change.payload);
        const id = change.item_id ?? await nextSequence('menuItems');
        transaction.set(collection('menuItems').doc(String(id)), {
          ...payload,
          created_at: timestamp(),
          updated_at: timestamp()
        }, { merge: true });
      }
      transaction.update(ref, {
        status: req.body.decision,
        review_note: req.body.reviewNote || null,
        reviewed_by: req.user.id,
        reviewed_at: timestamp()
      });
      return true;
    });
    if (!review) return res.status(404).json({ error: 'Pending menu change not found.' });
    res.json({ status: req.body.decision });
  } catch (error) {
    failure(res, error, error.message || 'Unable to review menu change.', 400);
  }
});

async function getOrdersForUser(uid) {
  const snapshot = await collection('orders').where('user_id', '==', uid).get();
  return snapshot.docs.map((doc) => {
    const order = asPublicDocument(doc);
    return { ...order, items: JSON.stringify(parseOrderItems(order)) };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

app.get(['/api/my-orders', '/api/orders'], authenticateToken, async (req, res) => {
  try {
    res.json(await getOrdersForUser(req.user.id));
  } catch (error) {
    failure(res, error, 'Failed to fetch orders');
  }
});

app.get('/api/admin/orders', authenticateToken, isStaffOrAdmin, async (req, res) => {
  try {
    const snapshot = await collection('orders').get();
    const orders = await Promise.all(snapshot.docs.map(async (doc) => {
      const order = asPublicDocument(doc);
      const userSnapshot = order.user_id ? await collection('users').doc(order.user_id).get() : null;
      return {
        ...order,
        items: JSON.stringify(parseOrderItems(order)),
        customer_email: req.user.role === 'admin' ? userSnapshot?.data()?.email || null : null
      };
    }));
    res.json(orders.sort((a, b) => b.created_at.localeCompare(a.created_at)));
  } catch (error) {
    failure(res, error, 'Unable to load orders.');
  }
});

app.post('/api/orders', authenticateToken, isParent, async (req, res) => {
  try {
    const result = await createOrder({
      ...req.body,
      userId: req.user.id,
      customerName: req.body.customerName || req.user.full_name
    });
    res.json(result);
  } catch (error) {
    failure(res, error, error.message || 'Failed to create order', error.status || 500);
  }
});

app.post('/api/guest-checkout', async (req, res) => {
  try {
    res.json(await createOrder(req.body));
  } catch (error) {
    failure(res, error, error.message || 'Failed to process checkout', error.status || 500);
  }
});

app.post('/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    res.json(await createOrder({ ...req.body, userId: req.user.id }));
  } catch (error) {
    failure(res, error, error.message || 'Failed to process checkout', error.status || 500);
  }
});

app.get('/api/payment-status/:orderNumber', async (req, res) => {
  try {
    const snapshot = await collection('orders').where('order_number', '==', req.params.orderNumber).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Order not found' });
    const order = snapshot.docs[0].data();
    if (order.payment_status === 'completed' && !order.receipt_sent_at && smtpTransporter) {
      sendOrderReceipt(snapshot.docs[0].id).catch((error) => console.error('Receipt email failed:', error));
    }
    res.json({
      orderNumber: order.order_number,
      totalAmount: order.total_amount,
      paymentStatus: order.payment_status,
      orderStatus: order.status
    });
  } catch (error) {
    failure(res, error, 'Unable to check payment status.');
  }
});

app.post('/api/payments/zynle-callback', async (req, res) => {
  try {
    const callbackData = req.body || {};
    const status = String(callbackData.status || callbackData.state || callbackData.data?.status || '').toUpperCase();
    const transactionId = callbackData.transactionId || callbackData.reference || callbackData.paymentId ||
      callbackData.data?.transactionId || callbackData.id;
    if (transactionId && ['SUCCESS', 'PAID', 'COMPLETED', 'APPROVED'].includes(status)) {
      await markPaymentCompleted(String(transactionId), callbackData);
    }
    res.json({ status: 'received' });
  } catch (error) {
    failure(res, error, 'Payment callback processing failed.');
  }
});

app.post('/api/admin/staff', authenticateToken, isAdmin, [
  body('username').isEmail(),
  body('password').isLength({ min: 6 }),
  body('full_name').optional().isString(),
  body('phone').optional().isString()
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const { auth } = services();
    const created = await auth.createUser({
      email: req.body.username.trim().toLowerCase(),
      password: req.body.password,
      displayName: req.body.full_name || ''
    });
    const user = {
      email: created.email,
      full_name: req.body.full_name || '',
      phone: req.body.phone || '',
      role: 'staff',
      reminder_preferences: { email_enabled: false, push_enabled: false },
      created_at: timestamp(),
      updated_at: timestamp()
    };
    await collection('users').doc(created.uid).set(user);
    res.status(201).json({
      message: 'Staff account created successfully.',
      user: { id: created.uid, username: created.email, full_name: user.full_name, phone: user.phone, role: 'staff' }
    });
  } catch (error) {
    failure(res, error, error.code === 'auth/email-already-exists'
      ? 'An account with this email already exists.' : 'Failed to create staff account.',
    error.code === 'auth/email-already-exists' ? 409 : 500);
  }
});

app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await collection('users').get();
    res.json(snapshot.docs.map((doc) => {
      const user = doc.data();
      return {
        id: doc.id,
        username: user.email || '',
        full_name: user.full_name || '',
        phone: user.phone || '',
        role: user.role || 'customer',
        created_at: user.created_at || null
      };
    }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
  } catch (error) {
    failure(res, error, 'Unable to load user accounts.');
  }
});

app.put('/api/admin/users/:userId/role', authenticateToken, isAdmin, [
  body('role').isIn(['customer', 'staff', 'admin'])
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'You cannot change your own account role.' });
  try {
    const ref = collection('users').doc(req.params.userId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'User not found.' });
    if (snapshot.data().role === 'admin' && req.body.role !== 'admin') {
      const admins = await collection('users').where('role', '==', 'admin').get();
      if (admins.size <= 1) return res.status(400).json({ error: 'The last administrator cannot be demoted.' });
    }
    await ref.update({ role: req.body.role, updated_at: timestamp() });
    res.json({ message: 'Account role updated successfully.' });
  } catch (error) {
    failure(res, error, 'Failed to update account role.');
  }
});

app.put('/api/admin/orders/:orderId/status', authenticateToken, isStaffOrAdmin, [
  body('status').isIn(['pending', 'confirmed', 'completed', 'cancelled'])
], async (req, res) => {
  if (validationErrors(req, res)) return;
  try {
    const ref = collection('orders').doc(req.params.orderId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Order not found' });
    await ref.update({ status: req.body.status, updated_at: timestamp() });
    res.json({ message: 'Order status updated successfully.' });
  } catch (error) {
    failure(res, error, 'Failed to update order');
  }
});

app.post('/api/admin/orders/:orderId/resend-receipt', authenticateToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await collection('orders').doc(req.params.orderId).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Order not found.' });
    if (snapshot.data().payment_status !== 'completed') return res.status(409).json({ error: 'Only successfully paid orders can receive a receipt.' });
    const email = await sendOrderReceipt(req.params.orderId);
    res.json({ message: 'Receipt resent successfully.', email });
  } catch (error) {
    failure(res, error, error.message || 'Unable to resend receipt.', smtpTransporter ? 502 : 503);
  }
});

app.get('/api/admin/reminder-schedules', authenticateToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await collection('reminderSchedules').get();
    res.json(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => a.time.localeCompare(b.time)));
  } catch (error) {
    failure(res, error, 'Unable to load reminder schedules.');
  }
});

app.post('/api/admin/reminder-schedules', authenticateToken, isAdmin, [
  body('name').isString().trim().isLength({ min: 1, max: 60 }),
  body('time').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('reminder_minutes').isInt({ min: 1, max: 180 }),
  body('enabled').optional().isBoolean()
], async (req, res) => {
  if (validationErrors(req, res)) return;
  if (!validReminderSchedule(req.body.name, req.body.time, Number(req.body.reminder_minutes))) {
    return res.status(400).json({ error: 'Reminder lead time must be 1-180 minutes and cannot cross into the previous day.' });
  }
  try {
    const ref = collection('reminderSchedules').doc();
    const schedule = {
      name: req.body.name.trim(),
      time: req.body.time,
      reminder_minutes: Number(req.body.reminder_minutes),
      enabled: req.body.enabled === undefined || Boolean(req.body.enabled),
      created_at: timestamp(),
      updated_at: timestamp()
    };
    await ref.set(schedule);
    res.status(201).json({ id: ref.id, ...schedule });
  } catch (error) {
    failure(res, error, 'Unable to create reminder schedule.');
  }
});

app.put('/api/admin/reminder-schedules/:scheduleId', authenticateToken, isAdmin, [
  body('name').optional().isString().trim().isLength({ min: 1, max: 60 }),
  body('time').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('reminder_minutes').optional().isInt({ min: 1, max: 180 }),
  body('enabled').optional().isBoolean()
], async (req, res) => {
  if (validationErrors(req, res)) return;
  const updates = { updated_at: timestamp() };
  for (const field of ['name', 'time', 'reminder_minutes', 'enabled']) {
    if (req.body[field] !== undefined) {
      updates[field] = field === 'name' ? req.body[field].trim() :
        field === 'reminder_minutes' ? Number(req.body[field]) : req.body[field];
    }
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'No reminder schedule fields were provided.' });
  try {
    const ref = collection('reminderSchedules').doc(req.params.scheduleId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Reminder schedule not found.' });
    const current = snapshot.data();
    if (!validReminderSchedule(updates.name || current.name, updates.time || current.time,
      updates.reminder_minutes ?? current.reminder_minutes)) {
      return res.status(400).json({ error: 'Reminder lead time must be 1-180 minutes and cannot cross into the previous day.' });
    }
    await ref.update(updates);
    res.json({ message: 'Reminder schedule updated.' });
  } catch (error) {
    failure(res, error, 'Unable to update reminder schedule.');
  }
});

app.delete('/api/admin/reminder-schedules/:scheduleId', authenticateToken, isAdmin, async (req, res) => {
  try {
    const ref = collection('reminderSchedules').doc(req.params.scheduleId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Reminder schedule not found.' });
    await ref.delete();
    res.status(204).end();
  } catch (error) {
    failure(res, error, 'Unable to delete reminder schedule.');
  }
});

app.post('/api/admin/menu/upload-signature', authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Image uploads are not configured. Contact the administrator.' });
  }
  const uploadTime = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp: uploadTime,
    folder: 'ltscanteen/menu',
    signature: createCloudinaryUploadSignature(CLOUDINARY_API_SECRET, uploadTime)
  });
});

app.post('/api/profile/upload-signature', authenticateToken, isParent, (req, res) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Profile photo uploads are not configured. Contact the administrator.' });
  }
  const uploadTime = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    timestamp: uploadTime,
    folder: 'ltscanteen/profiles',
    signature: cloudinaryProfileSignature(uploadTime)
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

async function sendScheduledReminders() {
  if (!smtpTransporter && !vapidConfigured) return;
  const clock = getSchoolClock();
  if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return;
  const currentMinutes = Number(clock.hour) * 60 + Number(clock.minute);
  const date = `${clock.year}-${clock.month}-${clock.day}`;
  const [schedulesSnapshot, usersSnapshot] = await Promise.all([
    collection('reminderSchedules').where('enabled', '==', true).get(),
    collection('users').where('role', 'in', ['customer', 'parent']).get()
  ]);
  const schedules = schedulesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((schedule) => {
      const [hour, minute] = schedule.time.split(':').map(Number);
      const due = hour * 60 + minute - schedule.reminder_minutes;
      return currentMinutes >= due && currentMinutes <= due + 4;
    });
  for (const schedule of schedules) {
    for (const userDoc of usersSnapshot.docs) {
      const user = userDoc.data();
      const preferences = user.reminder_preferences || {};
      const deliveryKey = `${userDoc.id}_${date}_${schedule.id}`;
      const deliveryRef = collection('reminderDeliveries').doc(deliveryKey);
      const delivered = await deliveryRef.get();
      const sent = delivered.data() || {};
      const updates = {};
      if (preferences.email_enabled && smtpTransporter && !sent.email) {
        await smtpTransporter.sendMail({
          from: process.env.SMTP_FROM,
          to: user.email,
          subject: `${schedule.name} is coming up`,
          text: `Hello ${user.full_name || 'Parent'}, ${schedule.name.toLowerCase()} starts in ${schedule.reminder_minutes} minutes at ${schedule.time}.`
        });
        updates.email = true;
      }
      if (preferences.push_enabled && vapidConfigured && !sent.push) {
        const subscriptions = await userDoc.ref.collection('pushSubscriptions').get();
        for (const subscriptionDoc of subscriptions.docs) {
          try {
            await webPush.sendNotification(subscriptionDoc.data(), JSON.stringify({
              title: `${schedule.name} reminder`,
              body: `${schedule.name} starts in ${schedule.reminder_minutes} minutes at ${schedule.time}.`
            }));
          } catch (error) {
            if ([404, 410].includes(error.statusCode)) await subscriptionDoc.ref.delete();
            else console.error('Push reminder failed:', error);
          }
        }
        updates.push = true;
      }
      if (Object.keys(updates).length) await deliveryRef.set({ ...sent, ...updates, updated_at: timestamp() }, { merge: true });
    }
  }
}

async function start() {
  try {
    await initializeFirebaseData();
    app.listen(PORT, () => {
      console.log(`Literacy Tree Canteen API listening on port ${PORT} with Firebase Firestore storage.`);
    });
    setInterval(() => {
      sendScheduledReminders().catch((error) => console.error('Scheduled reminder run failed:', error));
    }, 60000);
  } catch (error) {
    console.error('Unable to initialize Firebase application data:', error);
    process.exitCode = 1;
  }
}

start();
