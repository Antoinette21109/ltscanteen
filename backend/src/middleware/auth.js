import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import db from '../config/db.js';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  jwt.verify(token, env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    try {
      const account = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(user.id);
      if (!account) {
        return res.status(401).json({ error: 'Account not found.' });
      }
      req.user = { ...user, ...account };
      next();
    } catch (error) {
      console.error('Authentication error:', error);
      res.status(500).json({ error: 'Authentication failed.' });
    }
  });
};

export const isAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

export const isStaffOrAdmin = (req, res, next) => {
  if (!['staff', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Staff access required.' });
  }
  next();
};
