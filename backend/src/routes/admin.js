import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import db from '../config/db.js';
import { authenticateToken, isAdmin, isStaffOrAdmin } from '../middleware/auth.js';

const router = express.Router();

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
