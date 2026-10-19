import express from 'express';
import db from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { initiateZynlePayment } from '../services/zynleService.js';

const router = express.Router();

router.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

router.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, paymentMethod, customerName, phoneNumber, userId, user } = req.body;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (!paymentMethod || paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

    const total = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity || 1)), 0);
    const orderNumber = `LTS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const resolvedCustomerName = customerName || user?.full_name || user?.username || 'Guest';

    const insertOrder = userId
      ? db.prepare(`INSERT INTO orders (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      : db.prepare(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const info = userId
      ? insertOrder.run(orderNumber, userId, resolvedCustomerName, phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending')
      : insertOrder.run(orderNumber, resolvedCustomerName, phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending');
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

router.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { items, paymentMethod, phoneNumber, customerName } = req.body;
    const userId = req.user.id;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = `LTS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const info = db.prepare(`INSERT INTO orders (order_number, user_id, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(orderNumber, userId, customerName || req.user.username, phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending');

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
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.post('/api/guest-checkout', async (req, res) => {
  try {
    const { items, paymentMethod, customerName, phoneNumber } = req.body;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in cart' });
    if (paymentMethod !== 'zynle') return res.status(400).json({ error: 'Only ZynlePay is supported' });
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const phoneRegex = /^(09|07|096|097|095|076|077)\d{7,8}$/;
    if (!phoneRegex.test(phoneNumber)) return res.status(400).json({ error: 'Invalid Zambian phone number' });

    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = `LTS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const info = db.prepare(`INSERT INTO orders (order_number, customer_name, customer_phone, items, total_amount, payment_method, payment_status, msisdn, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(orderNumber, customerName || 'Guest', phoneNumber, JSON.stringify(items), total, paymentMethod, 'pending', phoneNumber, 'pending');

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
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to process checkout' });
  }
});

router.get('/api/payment-status/:orderNumber', async (req, res) => {
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

router.get('/api/my-orders', authenticateToken, (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.post('/api/payments/zynle-callback', express.json(), async (req, res) => {
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

export default router;
