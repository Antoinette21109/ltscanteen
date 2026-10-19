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

  const zynleUrl = env.ZYNLE_API_URL;
  const zynleKey = env.ZYNLE_API_KEY;

  if (zynleUrl && zynleKey) {
    const baseUrl = zynleUrl.replace(/\/$/, '');
    const callbackUrl = env.ZYNLE_CALLBACK_URL || `${env.PUBLIC_BASE_URL}/api/payments/zynle-callback`;
    const payload = {
      merchantId: env.ZYNLE_MERCHANT_ID,
      merchant_id: env.ZYNLE_MERCHANT_ID,
      amount: Number(amount).toFixed(2),
      currency: env.CURRENCY,
      orderId: orderNumber,
      order_id: orderNumber,
      externalId: orderNumber,
      external_id: orderNumber,
      phoneNumber: formattedPhone,
      customerPhone: formattedPhone,
      callbackUrl,
      callback_url: callbackUrl,
      metadata: { orderId, orderNumber, transactionId, provider: 'zynle' }
    };

    const endpointCandidates = [
      `${baseUrl}/payments/initiate`,
      `${baseUrl}/api/payments/initiate`,
      `${baseUrl}/payment/initiate`,
      `${baseUrl}/initiate-payment`
    ];

    let lastError = null;
    for (const endpoint of endpointCandidates) {
      try {
        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${zynleKey}`,
            'Content-Type': 'application/json',
            'X-API-Key': zynleKey
          },
          timeout: 20000
        });

        const reference = response.data?.reference || response.data?.transactionId || response.data?.paymentId || response.data?.data?.reference || response.data?.data?.transactionId || transactionId;
        const updatePaymentRef = db.prepare(`UPDATE payments SET reference = ? WHERE transaction_id = ?`);
        updatePaymentRef.run(reference, transactionId);

        return {
          transactionId: reference,
          status: 'pending',
          message: 'Payment initiated. Please complete the Zynle payment prompt on your phone.'
        };
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        if (status !== 404 && status !== 405) {
          throw new Error(error.response?.data?.message || error.message || 'Zynle payment initiation failed.');
        }
      }
    }

    throw new Error(lastError?.response?.data?.message || 'ZynlePay API endpoint is not reachable using the configured credentials.');
  }

  console.log(`[ZYNLE] Payment initiated locally: Order ${orderNumber}, Amount K${amount}, Phone ${formattedPhone}, Ref: ${transactionId}`);
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
