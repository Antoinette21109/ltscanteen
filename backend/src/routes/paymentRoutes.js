import express from 'express';
import db from '../config/db.js';
import zynleService from '../services/zynleService.js';

const router = express.Router();

router.post('/withdraw', async (req, res) => {
  try {
    const { amount, orderNumber, phoneNumber, customerName, orderId } = req.body;

    if (!amount || !orderNumber || !phoneNumber) {
      return res.status(400).json({ error: 'amount, orderNumber and phoneNumber are required.' });
    }

    const result = await zynleService.initiateWithdrawal({
      orderNumber,
      amount,
      phoneNumber,
      customerName: customerName || 'Customer',
      orderId
    });

    const insertPayment = db.prepare(`INSERT INTO payments (order_id, transaction_id, provider, amount, phone_number, status, reference)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertPayment.run(orderId || 0, result.referenceNo, 'zynle', Number(amount), phoneNumber, 'pending', result.referenceNo);

    res.json({
      success: true,
      provider: 'zynle',
      referenceNo: result.referenceNo,
      status: result.status,
      data: result.raw
    });
  } catch (error) {
    console.error('Zynle withdraw error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Zynle withdrawal failed.'
    });
  }
});

router.post('/status', async (req, res) => {
  try {
    const { reference_no } = req.body;

    if (!reference_no) {
      return res.status(400).json({ error: 'reference_no is required.' });
    }

    const result = await zynleService.checkTransactionStatus(reference_no);
    res.json(result);
  } catch (error) {
    console.error('Zynle status error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Unable to check payment status.'
    });
  }
});

router.post('/callback', async (req, res) => {
  try {
    const payload = req.body || {};
    const referenceNo = payload.reference_no || payload.referenceNo || payload.reference || payload.data?.reference_no;

    if (referenceNo) {
      const updatePayment = db.prepare(`UPDATE payments SET status = 'completed', callback_data = ? WHERE reference = ? OR transaction_id = ?`);
      updatePayment.run(JSON.stringify(payload), referenceNo, referenceNo);
    }

    res.json({ status: 'received' });
  } catch (error) {
    console.error('Zynle callback error:', error.message);
    res.status(200).json({ status: 'error' });
  }
});

export default router;
