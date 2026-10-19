import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import './config/env.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5500', 'https://ltscanteen.vercel.app', 'https://ltscanteen-81tsl2fb2-antoinette21109s-projects.vercel.app', process.env.FRONTEND_URL],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicRoot = path.resolve(__dirname, '../../');
app.use(express.static(publicRoot));

app.use(authRoutes);
app.use(orderRoutes);
app.use(adminRoutes);

app.get('*', (req, res) => {
  res.sendFile(path.join(publicRoot, 'index.html'));
});

export default app;
