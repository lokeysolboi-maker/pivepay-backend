require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── SERVE STATIC FILES ────────────────────────────────────────────
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

// ─── HELPERS ────────────────────────────────────────────────────────
function generateTxId(prefix = 'TX') {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────────
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
// 1. VTU PURCHASE (unchanged – works perfectly)
// ════════════════════════════════════════════════════════════════════
app.post('/api/vtu-proxy', async (req, res) => {
  const { userId, serviceId, amount, phone, planName, type, metadata, pin } = req.body;
  const txRef = generateTxId('VTU');

  try {
    if (!pin || pin.length !== 6) {
      return res.status(400).json({ success: false, error: 'Valid 6-digit PIN required' });
    }

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const userData = userSnap.data();

    if (userData.transactionPin !== pin) {
      return res.status(401).json({ success: false, error: 'Incorrect PIN' });
    }

    const numericAmount = Number(amount);
    if ((userData.walletBalance || 0) < numericAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    await userRef.update({
      walletBalance: admin.firestore.FieldValue.increment(-numericAmount)
    });

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

    if (vtuResponse.data?.code !== '000') {
      await userRef.update({
        walletBalance: admin.firestore.FieldValue.increment(numericAmount)
      });
      
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

    await db.collection('transactions').add({
      transactionId: txRef,
      userId, type: 'vtu_purchase', service: planName || type, 
      amount: numericAmount, phone,
      status: 'success',
      providerResponse: vtuResponse.data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
    try {
      await db.collection('users').doc(userId).update({
        walletBalance: admin.firestore.FieldValue.increment(Number(amount))
      });
    } catch(e) {}
    
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
// 2. BVN KYC (CORRECTED – uses real Flutterwave endpoints)
// ════════════════════════════════════════════════════════════════════
app.post('/api/kyc-initiate', async (req, res) => {
  try {
    const { bvn, firstname, lastname, uid } = req.body;

    if (!bvn || bvn.length !== 11) {
      return res.status(400).json({ success: false, error: 'BVN must be exactly 11 digits' });
    }

    const bvnResponse = await axios.post(
      'https://api.flutterwave.com/v3/bvn/verifications',
      {
        bvn,
        firstname,
        lastname,
        redirect_url: `${process.env.BASE_URL}/api/kyc-callback?uid=${uid}`
      },
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const respData = bvnResponse.data;

    if (respData.status === 'success') {
      const consentUrl = respData.data?.url;
      res.json({
        success: true,
        consent_url: consentUrl || null,
        reference: respData.data?.reference,
        already_consented: !consentUrl
      });
    } else {
      throw new Error(respData.message || 'BVN initiation failed');
    }
  } catch (error) {
    console.error('BVN Init Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

app.get('/api/kyc-callback', async (req, res) => {
  try {
    const { uid, reference } = req.query;
    if (!uid || !reference) return res.redirect('/#deposit?kyc=error');

    // Step 1: Verify BVN consent
    const verifyResponse = await axios.get(
      `https://api.flutterwave.com/v3/bvn/verifications/${reference}`,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );

    const bvnData = verifyResponse.data?.data;
    const isVerified = verifyResponse.data?.status === 'success' && bvnData?.status === 'COMPLETED';

    if (!isVerified) return res.redirect('/#deposit?kyc=failed');

    // Step 2: Pull user record
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.redirect('/#deposit?kyc=error');
    const user = userSnap.data();

    // Step 3: Create a REAL permanent virtual account
    const txRef = generateTxId('VA');
    const vaResponse = await axios.post(
      'https://api.flutterwave.com/v3/virtual-account-numbers',
      {
        email: user.email,
        tx_ref: txRef,
        phonenumber: user.phone || bvnData?.bvn_data?.phoneNumber2 || '00000000000',
        is_permanent: true,
        firstname: user.firstname || bvnData?.bvn_data?.firstName,
        lastname: user.lastname || bvnData?.bvn_data?.surname,
        narration: `${user.firstname || ''} ${user.lastname || ''}`.trim(),
        bvn: bvnData?.bvn_data?.bvn
      },
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const vaData = vaResponse.data?.data;

    // Step 4: Save everything to Firestore (including txRef for webhook matching)
    await db.collection('users').doc(uid).update({
      kycVerified: true,
      kycReference: reference,
      bvnData: bvnData?.bvn_data || {},
      virtualAccount: {
        accountNumber: vaData?.account_number,
        bankName: vaData?.bank_name,
        narration: vaData?.note,
        txRef: txRef,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.redirect('/#deposit?kyc=success');

  } catch (error) {
    console.error('BVN Callback Error:', error.response?.data || error.message);
    return res.redirect('/#deposit?kyc=error');
  }
});

// ════════════════════════════════════════════════════════════════════
// 3. DEPOSIT & WEBHOOK (UPDATED to handle bank transfers)
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

// WEBHOOK – handles both card payments and bank transfers
app.post('/api/webhook/flutterwave', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    if (signature !== process.env.FLW_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');

    const payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body)
      : req.body;

    const { tx_ref, status, amount, transaction_id, currency } = payload.data || {};
    const eventType = payload['event.type'];

    // Handle both card payments and virtual account bank transfers
    if (payload.event === 'charge.completed' && status === 'successful') {

      if (eventType === 'BANK_TRANSFER_TRANSACTION') {
        // Virtual account funding – match user by their virtual account txRef
        const usersSnap = await db.collection('users')
          .where('virtualAccount.txRef', '==', tx_ref)
          .limit(1)
          .get();

        if (!usersSnap.empty) {
          const userDoc = usersSnap.docs[0];
          await userDoc.ref.update({
            walletBalance: admin.firestore.FieldValue.increment(amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('transactions').add({
            transactionId: tx_ref,
            userId: userDoc.id,
            type: 'deposit',
            amount,
            currency: currency || 'NGN',
            status: 'success',
            flutterwaveTransactionId: transaction_id,
            paymentMethod: 'bank_transfer',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('activities').add({
            userId: userDoc.id,
            type: 'payment',
            description: `Wallet funded with ₦${amount} via bank transfer`,
            metadata: { tx_ref, transaction_id },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        }

      } else {
        // Regular card/link payment – match by transactionId in transactions collection
        const txSnapshot = await db.collection('transactions')
          .where('transactionId', '==', tx_ref)
          .limit(1).get();

        if (!txSnapshot.empty) {
          const doc = txSnapshot.docs[0];
          const data = doc.data();
          if (data.status === 'pending') {
            await doc.ref.update({ status: 'success', flutterwaveTransactionId: transaction_id, completedAt: admin.firestore.FieldValue.serverTimestamp() });
            await db.collection('users').doc(data.userId).update({
              walletBalance: admin.firestore.FieldValue.increment(amount),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('activities').add({
              userId: data.userId,
              type: 'payment',
              description: `Wallet funded with ₦${amount} via Flutterwave`,
              metadata: { tx_ref, transaction_id },
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
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
// 4. ADMIN API (unchanged – full control)
// ════════════════════════════════════════════════════════════════════
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

app.put('/api/admin/settings', authAdmin, async (req, res) => {
  try {
    const { depositFee, commissionRates } = req.body;
    const settingsRef = db.collection('platformSettings').doc('main');
    await settingsRef.set({ depositFee, commissionRates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/services', authAdmin, async (req, res) => {
  try {
    const { serviceId, defaultPrice, isActive } = req.body;
    await db.collection('servicePrices').doc(serviceId).set({ defaultPrice, isActive, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/referrals/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
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

app.delete('/api/admin/admins/:email', authAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const usersSnap = await db.collection('users').where('email', '==', email).get();
    if (usersSnap.empty) return res.status(404).json({ error: 'User not found' });
    const doc = usersSnap.docs[0];
    await doc.ref.update({ role: 'user' });
    res.json({ success: true, message: `Admin privileges removed for ${email}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 5. FRONTEND ROUTING
// ════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
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