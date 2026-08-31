require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');

// ─── INITIALIZE EXPRESS ────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── SERVE STATIC FILES ────────────────────────────────────────────
// This makes your logo, CSS, and other assets accessible
app.use(express.static('public'));

// ─── FIREBASE ADMIN ────────────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env variable. Ensure it is valid JSON.');
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require('./firebase-admin-key.json');
  } catch (e) {
    console.error('Missing Firebase credentials! Set FIREBASE_SERVICE_ACCOUNT env variable or provide firebase-admin-key.json');
    process.exit(1);
  }
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── FLUTTERWAVE ────────────────────────────────────────────────────
const Flutterwave = require('flutterwave-node-v3');
const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY,
  process.env.FLW_SECRET_KEY,
  process.env.FLW_ENCRYPTION_KEY
);

// ─── HELPER: Generate Unique Transaction IDs ──────────────────────
function generateTxId(prefix = 'TX') {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

// ─── HELPER: Admin Auth Middleware ────────────────────────────────
async function authAdmin(req, res, next) {
  try {
    const uid = req.headers['x-user-id'];
    if (!uid) return res.status(401).json({ error: 'Unauthorized: No User ID' });
    
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    
    const userData = userSnap.data();
    if (!userData.role || !['admin', 'supreme'].includes(userData.role)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    
    req.adminUid = uid;
    req.adminData = userData;
    next();
  } catch (error) {
    console.error('Admin Auth Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ════════════════════════════════════════════════════════════════════
// 1. VTU PURCHASE (SECURE + LOGS FAILED TX)
// ════════════════════════════════════════════════════════════════════
app.post('/api/vtu-proxy', async (req, res) => {
  const { userId, serviceId, amount, phone, planName, type, metadata, pin } = req.body;
  const txRef = generateTxId('VTU'); // Unique ID for EVERY attempt

  try {
    // 1. Validate PIN
    if (!pin || pin.length !== 6) {
      return res.status(400).json({ success: false, error: 'Valid 6-digit PIN required' });
    }

    // 2. Fetch User
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const userData = userSnap.data();

    // 3. Verify PIN (plain text for now – upgrade to bcrypt later)
    if (userData.transactionPin !== pin) {
      return res.status(401).json({ success: false, error: 'Incorrect PIN' });
    }

    // 4. Check Balance
    const numericAmount = Number(amount);
    if ((userData.walletBalance || 0) < numericAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    // 5. Deduct Balance (Temporary hold)
    await userRef.update({
      walletBalance: admin.firestore.FieldValue.increment(-numericAmount)
    });

    // 6. Call VTU Provider
    const vtuPayload = {
      serviceID: serviceId,
      amount: numericAmount,
      phone: phone,
      variation_code: metadata?.variation_code || '',
      request_id: txRef,
    };

    const vtuResponse = await axios.post(
      `${process.env.VTU_BASE_URL}/pay`,
      vtuPayload,
      { headers: { 'api-key': process.env.VTU_API_KEY, 'Content-Type': 'application/json' } }
    );

    // 7. Handle VTU Response
    if (vtuResponse.data?.code !== '000') {
      // ❌ FAILURE: Refund user immediately
      await userRef.update({
        walletBalance: admin.firestore.FieldValue.increment(numericAmount)
      });
      
      // **LOG FAILED TRANSACTION**
      await db.collection('transactions').add({
        transactionId: txRef,
        userId, type: 'vtu_purchase', service: planName || type, 
        amount: numericAmount, phone,
        status: 'failed',
        error: vtuResponse.data?.response_description || 'VTU provider error',
        providerResponse: vtuResponse.data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(400).json({ 
        success: false, 
        transactionId: txRef,
        error: 'VTU provider declined the request' 
      });
    }

    // ✅ SUCCESS: Log successful transaction
    await db.collection('transactions').add({
      transactionId: txRef,
      userId, type: 'vtu_purchase', service: planName || type, 
      amount: numericAmount, phone,
      status: 'success',
      providerResponse: vtuResponse.data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Log Activity
    await db.collection('activities').add({
      transactionId: txRef,
      userId,
      type: 'purchase',
      description: `Purchased ${planName} for ₦${numericAmount} (${phone})`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ 
      success: true, 
      transactionId: txRef, 
      data: vtuResponse.data 
    });

  } catch (error) {
    console.error('VTU Route Error:', error);
    // If error occurs AFTER deduction but BEFORE response, ensure refund
    try {
      await db.collection('users').doc(userId).update({
        walletBalance: admin.firestore.FieldValue.increment(Number(amount))
      });
    } catch(e) {}
    
    // Log catastrophic failure
    await db.collection('transactions').add({
      transactionId: txRef,
      userId, type: 'vtu_purchase', service: planName || type, 
      amount: Number(amount) || 0, phone: phone || 'unknown',
      status: 'failed',
      error: error.message || 'System error',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(500).json({ success: false, transactionId: txRef, error: error.message || 'Purchase failed' });
  }
});

// ════════════════════════════════════════════════════════════════════
// 2. BVN KYC
// ════════════════════════════════════════════════════════════════════
app.post('/api/kyc-initiate', async (req, res) => {
  try {
    const { bvn, firstname, lastname, email, phone, uid } = req.body;
    const payload = {
      bvn, firstname, lastname, email, phone,
      callback_url: `${process.env.BASE_URL}/api/kyc-callback?uid=${uid}`,
    };
    const bvnResponse = await axios.post(
      `${process.env.BVN_BASE_URL || 'https://api.flutterwave.com/v3'}/identity/consent`,
      payload,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );
    if (bvnResponse.data?.status === 'success') {
      res.json({ success: true, consent_url: bvnResponse.data.data.consent_url, reference: bvnResponse.data.data.reference });
    } else {
      throw new Error(bvnResponse.data?.message || 'BVN initiation failed');
    }
  } catch (error) {
    console.error('BVN Init Error:', error);
    res.status(500).json({ success: false, error: error.message || 'BVN consent initiation failed' });
  }
});

app.get('/api/kyc-callback', async (req, res) => {
  try {
    const { uid, reference } = req.query;
    if (!uid) return res.redirect('/#deposit?kyc=error');
    const verifyResponse = await axios.get(
      `${process.env.BVN_BASE_URL || 'https://api.flutterwave.com/v3'}/identity/verify/${reference}`,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    if (verifyResponse.data?.status === 'success' && verifyResponse.data?.data?.verified) {
      // Generate a mock virtual account (Flutterwave would return a real one)
      const accountNumber = `VA${Date.now().toString().slice(-10)}`;
      await db.collection('users').doc(uid).update({
        kycVerified: true,
        kycDetails: verifyResponse.data.data,
        virtualAccount: { accountNumber: accountNumber, bankName: 'Wema Bank' },
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

// ════════════════════════════════════════════════════════════════════
// 3. DEPOSIT (Flutterwave)
// ════════════════════════════════════════════════════════════════════
app.post('/api/initiate-payment', async (req, res) => {
  try {
    const { amount, email, name, uid } = req.body;
    const txRef = generateTxId('DEP');
    
    const paymentData = {
      tx_ref: txRef,
      amount,
      currency: 'NGN',
      payment_options: 'card,banktransfer,ussd',
      redirect_url: `${process.env.BASE_URL}/api/payment-callback?uid=${uid}&tx_ref=${txRef}`,
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
        transactionId: txRef,
        userId: uid, type: 'deposit', amount,
        status: 'pending',
        paymentLink: response.data.link,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ status: 'success', data: { link: response.data.link, transactionId: txRef } });
    } else {
      throw new Error(response.message || 'Payment initialization failed');
    }
  } catch (error) {
    console.error('Payment Init Error:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────
app.post('/api/webhook/flutterwave', async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    if (signature !== process.env.FLW_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');

    const { tx_ref, status, amount, transaction_id } = req.body;
    const txSnapshot = await db.collection('transactions')
      .where('transactionId', '==', tx_ref)
      .limit(1)
      .get();

    if (txSnapshot.empty) return res.status(404).send('Transaction not found');
    const doc = txSnapshot.docs[0];
    const data = doc.data();

    if (status === 'successful' && data.status === 'pending') {
      await doc.ref.update({ status: 'success', flutterwaveTransactionId: transaction_id, completedAt: admin.firestore.FieldValue.serverTimestamp() });
      await db.collection('users').doc(data.userId).update({
        walletBalance: admin.firestore.FieldValue.increment(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection('activities').add({
        userId: data.userId,
        type: 'payment',
        description: `Wallet funded with ₦${amount} via Flutterwave`,
        metadata: { tx_ref, transaction_id },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await doc.ref.update({ status: 'failed' });
    }
    res.send('Webhook processed');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Webhook error');
  }
});

app.get('/api/payment-callback', (req, res) => {
  const { status } = req.query;
  res.redirect(status === 'successful' ? '/#deposit?payment=success' : '/#deposit?payment=failed');
});

// ════════════════════════════════════════════════════════════════════
// 4. ADMIN API (Full control)
// ════════════════════════════════════════════════════════════════════

// ─── STATS ────────────────────────────────────────────────────────
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const txSnap = await db.collection('transactions').where('status', '==', 'success').get();
    const totalRevenue = txSnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
    
    res.json({
      totalUsers: usersSnap.size,
      totalRevenue,
      totalTransactions: (await db.collection('transactions').get()).size,
      pendingReferrals: (await db.collection('referrals').where('status', '==', 'pending').get()).size,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── USERS ────────────────────────────────────────────────────────
app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const { limit = 50, startAfter } = req.query;
    let query = db.collection('users').orderBy('createdAt', 'desc').limit(Number(limit));
    if (startAfter) {
      const snap = await db.collection('users').doc(startAfter).get();
      query = query.startAfter(snap);
    }
    const snapshot = await query.get();
    const users = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ users, lastDoc: snapshot.docs[snapshot.docs.length-1]?.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRANSACTIONS ────────────────────────────────────────────────
app.get('/api/admin/transactions', authAdmin, async (req, res) => {
  try {
    const { search, status, type, limit = 50 } = req.query;
    let query = db.collection('transactions').orderBy('createdAt', 'desc').limit(Number(limit));
    
    if (search) {
      const searchSnap = await db.collection('transactions')
        .where('transactionId', '==', search)
        .limit(1)
        .get();
      if (!searchSnap.empty) {
        return res.json({ transactions: searchSnap.docs.map(d => ({ id: d.id, ...d.data() })) });
      }
    }
    if (status) query = query.where('status', '==', status);
    if (type) query = query.where('type', '==', type);
    
    const snapshot = await query.get();
    const transactions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ transactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SETTINGS (Deposit Fee & Commission) ────────────────────────
app.put('/api/admin/settings', authAdmin, async (req, res) => {
  try {
    const { depositFee, commissionRates } = req.body;
    const settingsRef = db.collection('platformSettings').doc('main');
    await settingsRef.set({ depositFee, commissionRates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVICES (Update price/status) ─────────────────────────────
app.put('/api/admin/services', authAdmin, async (req, res) => {
  try {
    const { serviceId, defaultPrice, isActive } = req.body;
    await db.collection('servicePrices').doc(serviceId).set({ defaultPrice, isActive, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REFERRAL WITHDRAWALS (Approve/Reject) ─────────────────────
app.put('/api/admin/referrals/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' or 'rejected'
    const refSnap = await db.collection('referrals').doc(id).get();
    if (!refSnap.exists) return res.status(404).json({ error: 'Not found' });
    const data = refSnap.data();
    if (status === 'approved') {
      await db.collection('users').doc(data.userId).update({
        walletBalance: admin.firestore.FieldValue.increment(data.amount)
      });
    }
    await refSnap.ref.update({ status, processedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADD ADMIN ────────────────────────────────────────────────────
app.post('/api/admin/admins', authAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const usersSnap = await db.collection('users').where('email', '==', email).get();
    if (usersSnap.empty) return res.status(404).json({ error: 'User not found' });
    const doc = usersSnap.docs[0];
    await doc.ref.update({ role: 'admin' });
    res.json({ success: true, message: `${email} is now an admin` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REMOVE ADMIN ─────────────────────────────────────────────────
app.delete('/api/admin/admins/:email', authAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    // Prevent removing supreme admins (optional, but good practice)
    // You can check against a hardcoded list or just allow it.
    const usersSnap = await db.collection('users').where('email', '==', email).get();
    if (usersSnap.empty) return res.status(404).json({ error: 'User not found' });
    const doc = usersSnap.docs[0];
    await doc.ref.update({ role: 'user' });
    res.json({ success: true, message: `Admin privileges removed for ${email}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 5. FRONTEND ROUTING (FIXES THE "Cannot GET /" ERROR)
// ════════════════════════════════════════════════════════════════════

// Health check (optional, good for monitoring)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── SERVE INDEX.HTML ─────────────────────────────────────────────
// This explicitly serves your main HTML file at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── CATCH-ALL FOR SPA (Client-side routing) ────────────────────
// If a request isn't for an API, serve index.html
// This allows users to refresh pages like /#dashboard without errors
app.get('*', (req, res) => {
  // Ignore API calls (they should have returned 404 earlier if not found)
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  // For any other path, serve the index.html (SPA fallback)
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════════════════
// 6. START SERVER
// ════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PIVEPAY backend running on port ${PORT}`);
  console.log(`📁 Serving static files from: ${path.join(__dirname, 'public')}`);
});
