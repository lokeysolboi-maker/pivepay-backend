// ============================================================
// PIVEPAY BACKEND – Full Express Server
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// 1. SERVE STATIC FILES FROM THE ROOT (NO public FOLDER NEEDED)
// ============================================================
app.use(express.static(__dirname));  // ← CHANGED THIS LINE

// ============================================================
// 2. FIREBASE ADMIN SDK – Load from env (production) or file (local)
// ============================================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-admin-key.json');
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ============================================================
// 3. FLUTTERWAVE – Initialize
// ============================================================
const Flutterwave = require('flutterwave-node-v3');
const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY,
  process.env.FLW_SECRET_KEY,
  process.env.FLW_ENCRYPTION_KEY
);

// ============================================================
// 4. API ROUTES
// ============================================================

// ---------- 4a. VTU Proxy ----------
app.post('/api/vtu-proxy', async (req, res) => {
  try {
    const { userId, serviceId, amount, phone, planName, type, metadata } = req.body;

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const vtuPayload = {
      serviceID: serviceId,
      amount: amount,
      phone: phone,
      variation_code: metadata?.variation_code || '',
      request_id: `pivepay-${Date.now()}`,
    };

    const vtuResponse = await axios.post(
      `${process.env.VTU_BASE_URL}/pay`,
      vtuPayload,
      {
        headers: {
          'api-key': process.env.VTU_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (vtuResponse.data?.code !== '000') {
      throw new Error(vtuResponse.data?.response_description || 'VTU provider error');
    }

    const txRef = `TX-${Date.now()}-${userId.slice(0, 6)}`;
    await db.collection('transactions').add({
      userId,
      type,
      service: planName || type,
      amount,
      reference: txRef,
      status: 'success',
      basePrice: amount,
      commissionRate: 0,
      providerResponse: vtuResponse.data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('activities').add({
      userId,
      type: 'purchase',
      description: `Purchased ${planName} for ₦${amount}`,
      metadata: { serviceId, phone },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      transactionId: txRef,
      data: vtuResponse.data,
    });
  } catch (error) {
    console.error('VTU Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'VTU service failed',
    });
  }
});

// ---------- 4b. BVN Initiate ----------
app.post('/api/kyc-initiate', async (req, res) => {
  try {
    const { bvn, firstname, lastname, email, phone, uid } = req.body;

    const payload = {
      bvn,
      firstname,
      lastname,
      email,
      phone,
      callback_url: `${process.env.BASE_URL}/api/kyc-callback?uid=${uid}`,
    };

    const bvnResponse = await axios.post(
      `${process.env.BVN_BASE_URL}/v1/identity/consent`,
      payload,
      {
        headers: {
          'api-key': process.env.BVN_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (bvnResponse.data?.status === 'success') {
      res.json({
        success: true,
        consent_url: bvnResponse.data.data.consent_url,
        reference: bvnResponse.data.data.reference,
      });
    } else {
      throw new Error(bvnResponse.data?.message || 'BVN initiation failed');
    }
  } catch (error) {
    console.error('BVN Init Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'BVN consent initiation failed',
    });
  }
});

// ---------- 4c. BVN Callback ----------
app.get('/api/kyc-callback', async (req, res) => {
  try {
    const { uid, status, reference } = req.query;
    if (!uid) return res.redirect('/#deposit?kyc=error');

    const verifyResponse = await axios.get(
      `${process.env.BVN_BASE_URL}/v1/identity/verify/${reference}`,
      {
        headers: { 'api-key': process.env.BVN_API_KEY },
      }
    );

    if (verifyResponse.data?.status === 'success' && verifyResponse.data?.data?.verified) {
      await db.collection('users').doc(uid).update({
        kycVerified: true,
        kycDetails: verifyResponse.data.data,
        virtualAccount: {
          accountNumber: `VA${Date.now().toString().slice(-10)}`,
          bankName: 'Wema Bank',
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.redirect('/#deposit?kyc=success');
    } else {
      return res.redirect('/#deposit?kyc=failed');
    }
  } catch (error) {
    console.error('BVN Callback Error:', error);
    return res.redirect('/#deposit?kyc=error');
  }
});

// ---------- 4d. Initiate Payment (Flutterwave) ----------
app.post('/api/initiate-payment', async (req, res) => {
  try {
    const { amount, email, name, uid } = req.body;
    const txRef = `PIVEPAY-${Date.now()}-${uid.slice(0, 6)}`;

    const paymentData = {
      tx_ref: txRef,
      amount: amount,
      currency: 'NGN',
      payment_options: 'card,banktransfer,ussd',
      redirect_url: `${process.env.BASE_URL}/api/payment-callback?uid=${uid}`,
      customer: { email, name },
      customizations: {
        title: 'PIVEPAY Wallet Funding',
        description: `Deposit ₦${amount} into your PIVEPAY wallet`,
        logo: `${process.env.BASE_URL}/logo.png`,
      },
    };

    const response = await flw.Payment.initialize(paymentData);

    if (response.status === 'success') {
      await db.collection('transactions').add({
        userId: uid,
        type: 'wallet',
        amount,
        reference: txRef,
        status: 'pending',
        paymentLink: response.data.link,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ status: 'success', data: { link: response.data.link } });
    } else {
      throw new Error(response.message || 'Payment initialization failed');
    }
  } catch (error) {
    console.error('Payment Init Error:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ---------- 4e. Flutterwave Webhook ----------
app.post('/api/webhook/flutterwave', async (req, res) => {
  try {
    const secretHash = process.env.FLW_WEBHOOK_SECRET || 'your-webhook-secret';
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== secretHash) {
      return res.status(401).send('Unauthorized');
    }

    const { tx_ref, status, amount, transaction_id } = req.body;

    if (status === 'successful') {
      const txSnapshot = await db.collection('transactions')
        .where('reference', '==', tx_ref)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      if (txSnapshot.empty) return res.status(404).send('Transaction not found');

      const txDoc = txSnapshot.docs[0];
      const userId = txDoc.data().userId;

      await txDoc.ref.update({
        status: 'success',
        flutterwaveTransactionId: transaction_id,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('users').doc(userId).update({
        walletBalance: admin.firestore.FieldValue.increment(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('activities').add({
        userId,
        type: 'payment',
        description: `Wallet funded with ₦${amount} via Flutterwave`,
        metadata: { tx_ref, transaction_id },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.send('Webhook processed');
    } else {
      const txSnapshot = await db.collection('transactions')
        .where('reference', '==', tx_ref)
        .limit(1)
        .get();
      if (!txSnapshot.empty) {
        await txSnapshot.docs[0].ref.update({
          status: 'failed',
          flutterwaveTransactionId: transaction_id || null,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return res.send('Webhook processed (non-successful)');
    }
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(500).send('Webhook error');
  }
});

// ---------- 4f. Payment Callback ----------
app.get('/api/payment-callback', (req, res) => {
  const { uid, status, tx_ref } = req.query;
  if (status === 'successful') {
    return res.redirect('/#deposit?payment=success');
  } else {
    return res.redirect('/#deposit?payment=failed');
  }
});

// ---------- 4g. Health Check ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// 5. START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PIVEPAY backend running on port ${PORT}`);
});