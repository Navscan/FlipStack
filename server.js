const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// 🗄️ MOCK DEVELOPERS (We'll move this to the database later)
const developers = {
    'neatly-app': { name: 'Neatly', paystackSecret: process.env.PAYSTACK_SECRET_KEY },
    'super-game': { name: 'Super Game', paystackSecret: 'sk_test_fake_key_for_super_game_123' }
};

// ==========================================
// DATABASE CONNECTION & SERVER STARTUP
// ==========================================
const client = new MongoClient(process.env.MONGODB_URI);
let db, entitlements;

async function startServer() {
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB Atlas');
        
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');

        // Start the Express server only AFTER database connects
        app.listen(PORT, () => {
            console.log(`🚀 FlipStack listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB', err);
    }
}

// ==========================================
// 1. THE WEBHOOK (The "Flipper")
// ==========================================
app.post('/webhook/:app_id', async (req, res) => {
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
        
        try {
            // 🎯 THE FLIP: Save to MongoDB! 
            // If the user exists, update them. If not, create them (upsert).
            await entitlements.updateOne(
                { app_id: appId, user_id: userId },
                { $set: { tier: 'pro', updated_at: new Date() } },
                { upsert: true }
            );
            console.log(`✅ [${developer.name}] Flipped User ${userId} to PRO (Saved to DB)`);
        } catch (dbErr) {
            console.error('Database error:', dbErr);
            return res.status(500).send('Database error');
        }
    }

    res.status(200).send('Webhook received');
});

// ==========================================
// 2. THE ENTITLEMENT API (The App calls this)
// ==========================================
app.get('/api/entitlement', async (req, res) => {
    const { app_id, user_id } = req.query;

    if (!app_id || !user_id) {
        return res.status(400).json({ error: 'Missing app_id or user_id' });
    }

    try {
        // Look up the user in MongoDB
        const record = await entitlements.findOne({ app_id, user_id });
        
        res.json({
            app_id,
            user_id,
            tier: record ? record.tier : 'free'
        });
    } catch (dbErr) {
        console.error('Database error:', dbErr);
        res.status(500).json({ error: 'Database error' });
    }
});

startServer();