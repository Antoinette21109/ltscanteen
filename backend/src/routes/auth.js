import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import db from '../config/db.js';
import { env } from '../config/env.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/api/register', [
  body('username').isEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('full_name').optional().isString(),
  body('phone').optional().isString()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password, full_name, phone } = req.body;

  try {
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password, full_name, phone, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hashedPassword, full_name || '', phone || '', 'customer');

    const token = jwt.sign(
      { id: result.lastInsertRowid, username, role: 'customer' },
      env.JWT_SECRET,
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

router.post('/api/login', [
  body('username').isEmail().withMessage('Please enter a valid email'),
  body('password').notEmpty().withMessage('Password is required'),
  body('role').optional().isIn(['parent', 'staff', 'admin']).withMessage('Please select a valid account type')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password } = req.body;
  const requestedRole = req.body.role || 'parent';

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValidPassword = bcrypt.compareSync(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const userRole = user.role === 'parent' ? 'customer' : user.role;
    const expectedRole = requestedRole === 'parent' ? 'customer' : requestedRole;
    if (userRole !== expectedRole) {
      return res.status(403).json({ error: 'This account does not have access to the selected sign-in.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: userRole },
      env.JWT_SECRET,
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

router.get('/api/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, full_name, phone, role, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.put('/api/profile', authenticateToken, [
  body('full_name').optional().isString(),
  body('phone').optional().isString(),
  body('currentPassword').optional().isString(),
  body('newPassword').optional().isLength({ min: 6 })
], async (req, res) => {
  try {
    const { full_name, phone, currentPassword, newPassword } = req.body;
    const userId = req.user.id;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (currentPassword || newPassword) {
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new passwords are required together' });
      }

      const isValidPassword = bcrypt.compareSync(currentPassword, user.password);
      if (!isValidPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
    }

    const updates = [];
    const params = [];

    if (full_name !== undefined) {
      updates.push('full_name = ?');
      params.push(full_name);
    }

    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone);
    }

    if (newPassword) {
      updates.push('password = ?');
      params.push(bcrypt.hashSync(newPassword, 10));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No profile fields to update' });
    }

    params.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedUser = db.prepare('SELECT id, username, full_name, phone, role FROM users WHERE id = ?').get(userId);
    res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
