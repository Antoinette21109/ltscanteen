import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeMenuDatabase } from './menu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../../canteen.db');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const schema = `
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
`;

db.exec(schema);
initializeMenuDatabase(db);

const adminPassword = bcrypt.hashSync('Admin123!', 10);
db.prepare(`
  INSERT OR IGNORE INTO users (username, password, full_name, phone, role)
  VALUES (?, ?, ?, ?, ?)
`).run('admin@literacytree.com', adminPassword, 'School Administrator', '+260974754810', 'admin');

export default db;
