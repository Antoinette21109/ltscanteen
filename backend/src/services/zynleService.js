import axios from 'axios';
import crypto from 'crypto';
import db from '../config/db.js';
import { env } from '../config/env.js';

export async function initiateZynlePayment(orderNumber, amount, phoneNumber, orderId) {
  const formattedPhone = phoneNumber.replace(/\D/g, '');
  const transactionId = crypto.randomUUID();

  const insertPayment = db.prepare(`
    INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  insertPayment.run(orderId, transactionId, 'zynle', amount, phoneNumber);

  const apiId = env.ZYNLE_API_ID;
  const apiKey = env.ZYNLE_API_KEY;
  const merchantCode = env.ZYNLE_MERCHANT_CODE;

  if (apiId && apiKey && merchantCode) {
    const payload = {
      api_id: apiId,
      api_key: apiKey,
      merchant_code: merchantCode,
      amount: Number(amount).toFixed(2),
      reference_no: orderNumber,
      success_url: env.ZYNLE_SUCCESS_URL,
      failed_url: env.ZYNLE_FAILED_URL,
      description: `Canteen order ${orderNumber}`,
      phone_number: formattedPhone,
      customer_name: 'Customer',
      currency: env.CURRENCY
    };

    try {
      const response = await axios.post(env.ZYNLE_WITHDRAW_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*'
        },
        timeout: 30000
      });

      const reference = response.data?.reference_no || response.data?.reference || response.data?.transactionId || orderNumber;
      const updatePaymentRef = db.prepare(`UPDATE payments SET reference = ? WHERE transaction_id = ?`);
      updatePaymentRef.run(reference, transactionId);

      return {
        transactionId: reference,
        status: response.data?.response_code || 'pending',
        message: response.data?.message || 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
      };
    } catch (error) {
      console.error('Zynle API error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || error.message || 'Zynle payment initiation failed.');
    }
  }

  console.log(`[ZYNLE] Local simulation: Order ${orderNumber}, Amount K${amount}, Phone ${formattedPhone}, Ref: ${transactionId}`);
  setTimeout(() => {
    const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE transaction_id = ?`);
    updatePayment.run(JSON.stringify({ status: 'success', transactionId, amount, provider: 'zynle' }), transactionId);

    const updateOrder = db.prepare(`UPDATE orders SET payment_status = 'completed', status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    updateOrder.run(orderId);
  }, 3000);

  return {
    transactionId,
    status: 'pending',
    message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
  };
}

export async function checkZynleTransactionStatus(referenceNo) {
  const payload = {
    api_id: env.ZYNLE_API_ID,
    api_key: env.ZYNLE_API_KEY,
    reference_no: referenceNo
  };

  const response = await axios.post(env.ZYNLE_STATUS_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*'
    },
    timeout: 30000
  });

  return response.data;
}
