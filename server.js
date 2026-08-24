const express = require('express');
const admin = require('firebase-admin');

// 1. Initialize Firebase Admin using your service account key file
// Make sure 'serviceAccountKey.json' is in the same folder as this file.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
// Enable CORS if your frontend is hosted on a different domain/port
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// --- ROOT ROUTE (Health Check) ---
app.get('/', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    res.send(`✅ Vortex Backend Server is running! Connected to Firebase. Total registered users: ${usersSnapshot.size}`);
  } catch (error) {
    res.status(500).send("❌ Database connection error: " + error.message);
  }
});

// --- ADMIN ENDPOINT: Approve a User Deposit ---
// Call this from your admin panel backend logic when verifying a user's transaction ID
app.post('/api/admin/approve-deposit', async (req, res) => {
  try {
    const { depositId } = req.body;
    if (!depositId) {
      return res.status(400).json({ success: false, error: 'Deposit ID is required.' });
    }

    const depositRef = db.collection('deposits').doc(depositId);
    const depositDoc = await depositRef.get();

    if (!depositDoc.exists) {
      return res.status(404).json({ success: false, error: 'Deposit request not found.' });
    }

    const depositData = depositDoc.data();
    if (depositData.status === 'Approved') {
      return res.status(400).json({ success: false, error: 'Deposit is already approved.' });
    }

    const userId = depositData.userId;
    const amount = depositData.amount;

    // 1. Update user balance
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const userData = userDoc.data();
    const newBalance = (userData.balance || 0) + amount;

    const batch = db.batch();
    batch.update(userRef, { balance: newBalance });
    batch.update(depositRef, { status: 'Approved', credited: true, approvedAt: admin.firestore.FieldValue.serverTimestamp() });

    // 2. Log transaction for user history
    const txId = 'tx_dep_' + Date.now();
    const txRef = db.collection('transactions').doc(txId);
    batch.set(txRef, {
      id: txId,
      userId: userId,
      phone: depositData.phone,
      category: 'deposit',
      type: 'Deposit',
      title: `Deposit Approved - TX: ${depositData.transactionId}`,
      amount: amount,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Process 13% Referral Bonus if applicable
    if (userData.referredBy && !userData.referralBonusPaid) {
      const referrerId = userData.referredBy;
      const bonusAmount = Math.floor(amount * 0.13);

      if (bonusAmount > 0) {
        const referrerRef = db.collection('users').doc(referrerId);
        const referrerDoc = await referrerRef.get();

        if (referrerDoc.exists) {
          batch.update(referrerRef, {
            balance: admin.firestore.FieldValue.increment(bonusAmount),
            referralBalance: admin.firestore.FieldValue.increment(bonusAmount),
            totalEarned: admin.firestore.FieldValue.increment(bonusAmount)
          });

          const refTxId = 'ref_bonus_' + Date.now();
          const refTxRef = db.collection('transactions').doc(refTxId);
          batch.set(refTxRef, {
            id: refTxId,
            userId: referrerId,
            category: 'referral',
            type: 'Referral Bonus',
            title: `13% Referral Commission`,
            amount: bonusAmount,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
      batch.update(userRef, { referralBonusPaid: true });
    }

    await batch.commit();
    res.json({ success: true, message: `Deposit of UGX ${amount} approved successfully.` });

  } catch (err) {
    console.error("Error approving deposit:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADMIN ENDPOINT: Reject a User Deposit ---
app.post('/api/admin/reject-deposit', async (req, res) => {
  try {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ success: false, error: 'Deposit ID required.' });

    const depositRef = db.collection('deposits').doc(depositId);
    await depositRef.update({ status: 'Rejected' });

    res.json({ success: true, message: 'Deposit marked as rejected.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADMIN ENDPOINT: Reject/Refund a Withdrawal ---
app.post('/api/admin/reject-withdrawal', async (req, res) => {
  try {
    const { withdrawalId } = req.body;
    if (!withdrawalId) return res.status(400).json({ success: false, error: 'Withdrawal ID required.' });

    const wdRef = db.collection('withdrawals').doc(withdrawalId);
    const wdDoc = await wdRef.get();
    if (!wdDoc.exists) return res.status(404).json({ success: false, error: 'Withdrawal record not found.' });

    const wdData = wdDoc.data();
    if (wdData.status === 'Rejected') return res.status(400).json({ success: false, error: 'Already rejected.' });

    const userId = wdData.userId;
    const refundAmount = wdData.grossAmount;

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const currentBalance = userDoc.exists ? (userDoc.data().balance || 0) : 0;
    const newBalance = currentBalance + refundAmount;

    const batch = db.batch();
    batch.update(wdRef, { status: 'Rejected' });
    batch.update(userRef, { balance: newBalance });

    const txId = 'tx_refund_' + Date.now();
    batch.set(db.collection('transactions').doc(txId), {
      id: txId,
      userId: userId,
      phone: wdData.phone,
      category: 'refund',
      type: 'Refund',
      title: `Withdrawal Rejected: UGX ${refundAmount.toLocaleString()} refunded`,
      amount: refundAmount,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    res.json({ success: true, message: 'Withdrawal rejected and funds refunded to user balance.' });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`🚀 Vortex Server is live and listening on port ${port}`);
});
