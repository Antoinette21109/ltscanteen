import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const env = {
  PORT: Number(process.env.PORT || 3000),
  JWT_SECRET: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
  FRONTEND_URL: process.env.FRONTEND_URL || '',
  ZYNLE_API_ID: process.env.ZYNLE_API_ID || process.env.API_ID || '',
  ZYNLE_API_KEY: process.env.ZYNLE_API_KEY || process.env.API_KEY || '',
  ZYNLE_MERCHANT_CODE: process.env.ZYNLE_MERCHANT_CODE || process.env.MERCHANT_CODE || '',
  ZYNLE_SUCCESS_URL: process.env.ZYNLE_SUCCESS_URL || process.env.SUCCESS_URL || 'https://sandbox.zynlepay.com/transaction-success',
  ZYNLE_FAILED_URL: process.env.ZYNLE_FAILED_URL || process.env.FAILED_URL || 'https://sandbox.zynlepay.com/transaction-failed',
  ZYNLE_WITHDRAW_URL: process.env.ZYNLE_WITHDRAW_URL || 'https://sandbox.zynlepay.com/zynlepay/withdraw',
  ZYNLE_STATUS_URL: process.env.ZYNLE_STATUS_URL || 'https://sandbox.zynlepay.com/zynlepay/jsonapi/paymentstatus',
  ZYNLE_CALLBACK_URL: process.env.ZYNLE_CALLBACK_URL || '',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  CURRENCY: process.env.CURRENCY || 'ZMW',
};
