import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import db from '../config/db.js';
import { env } from '../config/env.js';
import { createCloudinaryUploadSignature, formatMenuItem, saveMenuItem, validateMenuItem } from '../config/menu.js';
import { authenticateToken, isAdmin, isStaffOrAdmin, requireMenuAccess } from '../middleware/auth.js';

const router = express.Router();

router.get('/api/menu/access', authenticateToken, isStaffOrAdmin, (req, res) => {
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

router.post('/api/menu/access-requests', authenticateToken, isStaffOrAdmin, (req, res) => {
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

router.post('/api/menu/upload-signature', authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return res.status(503).json({ error: 'Image uploads are not configured. Contact the administrator.' });
  }
  const timestamp = Math.floor(Date.now() / 1000);
  res.json({
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder: 'ltscanteen/menu',
    signature: createCloudinaryUploadSignature(env.CLOUDINARY_API_SECRET, timestamp)
  });
});

router.get('/api/menu/changes/mine', authenticateToken, isStaffOrAdmin, (req, res) => {
  const changes = db.prepare(`
    SELECT id, item_id, action, payload, status, review_note, created_at, reviewed_at
    FROM menu_change_requests WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id).map((change) => ({ ...change, payload: JSON.parse(change.payload) }));
  res.json(changes);
});

router.post('/api/menu/changes', authenticateToken, isStaffOrAdmin, requireMenuAccess, (req, res) => {
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

router.get('/api/admin/menu/access-requests', authenticateToken, isAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT r.id, r.user_id, r.session_id, r.status, r.requested_at,
      u.full_name, u.username
    FROM menu_access_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.requested_at ASC
  `).all();
  res.json(requests);
});

router.put('/api/admin/menu/access-requests/:requestId', authenticateToken, isAdmin, [
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

router.get('/api/admin/menu/changes', authenticateToken, isAdmin, (req, res) => {
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

router.put('/api/admin/menu/changes/:changeId/review', authenticateToken, isAdmin, [
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
        SELECT * FROM menu_change_requests
        WHERE id = ? AND status = 'pending'
      `).get(changeId);
      if (!change) {
        return false;
      }
      if (req.body.decision === 'approved') {
        const payload = validateMenuItem(JSON.parse(change.payload));
        saveMenuItem(db, change.item_id, payload);
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

router.get('/api/admin/orders', authenticateToken, isStaffOrAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(orders);
});

router.post('/api/admin/staff', authenticateToken, isAdmin, [
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

router.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, phone, role, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.put('/api/admin/users/:userId/role', authenticateToken, isAdmin, [
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

router.put('/api/admin/orders/:orderId/status', authenticateToken, isStaffOrAdmin, (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const result = db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, orderId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ message: 'Order status updated successfully' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
