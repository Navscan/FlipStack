const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// 🗄️ MOCK DATABASE (We will replace this with MongoDB)
const developers = {
    'neatly-app': { name: 'Neatly', paystackSecret: process.env.PAYSTACK_SECRET_KEY },
    'super-game': { name: 'Super Game', paystackSecret: 'sk_test_fake_key_for_super_game_123' }
};

// Keeps track of who is Pro!
const entitlements = {}; 

// ==========================================
// 1. THE WEBHOOK (The "Flipper")
// ==========================================
app.post('/webhook/:app_id', (req, res) => {
    const appId = req.params.app_id;
    const developer = developers[appId];
    
    if (!developer) return res.status(404).send('App not found');

    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');

    const expectedSignature = crypto
        .createHmac('sha512', developer.paystackSecret)
        .update(req.rawBody)
        .digest('hex');

    const isVerified = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );

    if (!isVerified) return res.status(401).send('Invalid signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const metadata = event.data.metadata || {};
        const userId = metadata.user_id;
        
        // 🎯 THE FLIP: Save the user as Pro in the database!
        entitlements[`${appId}_${userId}`] = 'pro';
        
        console.log(`✅ [${developer.name}] Flipped User ${userId} to PRO`);
    }

    res.status(200).send('Webhook received');
});

// ==========================================
// 2. THE ENTITLEMENT API (The App calls this)
// ==========================================
app.get('/api/entitlement', (req, res) => {
    const { app_id, user_id } = req.query;

    if (!app_id || !user_id) {
        return res.status(400).json({ error: 'Missing app_id or user_id' });
    }

    // Check the database
    const status = entitlements[`${app_id}_${user_id}`] || 'free';
    
    res.json({
        app_id,
        user_id,
        tier: status
    });
});

app.listen(PORT, () => {
    console.log(`🚀 FlipStack listening on port ${PORT}`);
});