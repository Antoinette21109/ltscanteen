import express from 'express';
import db from '../config/db.js';
import { authenticateToken, isAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/api/admin/orders', authenticateToken, isAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(orders);
});

router.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, phone, role, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.put('/api/admin/orders/:orderId/status', authenticateToken, isAdmin, (req, res) => {
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
