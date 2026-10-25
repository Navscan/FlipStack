const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CRITICAL: Keep raw body for webhook verification
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

const client = new MongoClient(process.env.MONGODB_URI);
let db, entitlements, apps;

async function startServer() {
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB Atlas');
        
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');
        apps = db.collection('apps'); // NEW: Collection for developers

        app.listen(PORT, () => {
            console.log(`🚀 FlipStack listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB', err);
    }
}

// ==========================================
// 1. REGISTER APP (Developer Onboarding)
// ==========================================
app.post('/api/register-app', async (req, res) => {
    const { name, paystack_secret } = req.body;

    if (!name || !paystack_secret) {
        return res.status(400).json({ error: 'Name and paystack_secret are required' });
    }

    // Generate a unique app_id (e.g., neatly-app-x8f9)
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const app_id = `${baseSlug}-${randomSuffix}`;

    try {
        await apps.insertOne({
            app_id,
            name,
            paystack_secret,
            created_at: new Date()
        });

        console.log(`✅ Registered new app: ${name} (${app_id})`);
        
        res.json({
            success: true,
            app_id,
            webhook_url: `https://api.flipstack.treasuretrail.africa/webhook/${app_id}`
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Failed to register app' });
    }
});

// ==========================================
// 2. THE WEBHOOK (The "Flipper")
// ==========================================
app.post('/webhook/:app_id', async (req, res) => {
    const appId = req.params.app_id;
    
    // Look up the developer in MongoDB instead of the hardcoded object
    const developer = await apps.findOne({ app_id: appId });
    if (!developer) return res.status(404).send('App not found');

    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');

    const expectedSignature = crypto
        .createHmac('sha512', developer.paystack_secret)
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
// 3. THE ENTITLEMENT API
// ==========================================
app.get('/api/entitlement', async (req, res) => {
    const { app_id, user_id } = req.query;

    if (!app_id || !user_id) {
        return res.status(400).json({ error: 'Missing app_id or user_id' });
    }

    try {
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