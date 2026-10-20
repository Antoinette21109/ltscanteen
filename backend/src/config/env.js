import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const env = {
  PORT: Number(process.env.PORT || 3000),
  JWT_SECRET: process.env.JWT_SECRET || '11fa26e29314717174ae8eed8f61f039d1a79773a9d84317f4a85588440a13906d970e7e196ed530df146a9ef5d72a2fc86decb4c1490cb0211b3bbba2819dfc',
  FRONTEND_URL: process.env.FRONTEND_URL || '',
  ZYNLE_API_URL: process.env.ZYNLE_API_URL || '',
  ZYNLE_API_KEY: process.env.ZYNLE_API_KEY || '',
  ZYNLE_SECRET_KEY: process.env.ZYNLE_SECRET_KEY || '',
  ZYNLE_MERCHANT_ID: process.env.ZYNLE_MERCHANT_ID || '',
  ZYNLE_CALLBACK_URL: process.env.ZYNLE_CALLBACK_URL || '',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  CURRENCY: process.env.CURRENCY || 'ZMW',
};
