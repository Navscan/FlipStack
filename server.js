const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: [
        'https://flipstack.treasuretrail.africa',
        'https://www.flipstack.treasuretrail.africa'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const client = new MongoClient(process.env.MONGODB_URI);
let db, entitlements, apps, developers, transactions;

async function startServer() {
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB Atlas');
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');
        apps = db.collection('apps'); 
        developers = db.collection('developers');
        transactions = db.collection('transactions'); // NEW COLLECTION

        app.listen(PORT, () => console.log(`🚀 FlipStack listening on port ${PORT}`));
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB', err);
    }
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = user;
        next();
    });
};

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
    try {
        const existing = await developers.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ error: 'Email already exists' });
        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(password, salt);
        await developers.insertOne({ email: email.toLowerCase(), password: hash, name, created_at: new Date() });
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const dev = await developers.findOne({ email: email.toLowerCase() });
        if (!dev || !(await bcrypt.compare(password, dev.password))) return res.status(401).json({ error: 'Invalid credentials' });
        const accessToken = jwt.sign({ id: dev._id.toString(), email: dev.email }, process.env.JWT_SECRET, { expiresIn: '15m' });
        const refreshToken = jwt.sign({ id: dev._id.toString() }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
        res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ accessToken, developer: { id: dev._id, email: dev.email, name: dev.name } });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/refresh', (req, res) => {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ error: 'No refresh token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        const accessToken = jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
        res.json({ accessToken });
    } catch (err) { res.clearCookie('refreshToken'); res.status(401).json({ error: 'Invalid refresh token' }); }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('refreshToken'); res.json({ success: true }); });

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        res.json({ developer: { id: dev._id, email: dev.email, name: dev.name } });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DEVELOPER SETTINGS & KEYS (NEW)
app.get('/api/dev/keys', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        const secret = dev.paystack_secret_key || '';
        const masked = secret.length > 8 ? `${secret.substring(0, 7)}...${secret.slice(-4)}` : '';
        res.json({ 
            public_key: dev.paystack_public_key || '', 
            secret_key_masked: masked 
        });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/keys', authenticateToken, async (req, res) => {
    const { public_key, secret_key } = req.body;
    try {
        const updateFields = { paystack_public_key: public_key };
        if (secret_key && secret_key.trim() !== '') {
            updateFields.paystack_secret_key = secret_key;
        }
        await developers.updateOne({ _id: new ObjectId(req.user.id) }, { $set: updateFields });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/profile', authenticateToken, async (req, res) => {
    const { name, email } = req.body;
    try {
        await developers.updateOne(
            { _id: new ObjectId(req.user.id) },
            { $set: { name, email: email.toLowerCase() } }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/password', authenticateToken, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        if (!dev || !(await bcrypt.compare(current_password, dev.password))) {
            return res.status(401).json({ error: 'Incorrect current password' });
        }
        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(new_password, salt);
        await developers.updateOne({ _id: new ObjectId(req.user.id) }, { $set: { password: hash } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// APP MANAGEMENT
app.get('/api/apps', authenticateToken, async (req, res) => {
    try {
        const myApps = await apps.find({ developerId: req.user.id }).toArray();
        const safeApps = myApps.map(app => {
            return {
                id: app._id,
                app_id: app.app_id,
                name: app.name,
                webhook_url: `https://api.flipstack.treasuretrail.africa/webhook/${app.app_id}`,
                category: app.category,
                description: app.description,
                price: app.price,
                icon_url: app.icon_url,
                aspect_ratio: app.aspect_ratio,
                created_at: app.created_at
            };
        });
        res.json({ apps: safeApps });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch apps' }); }
});

app.post('/api/apps', authenticateToken, async (req, res) => {
    const { name, category, description, price, icon_url, aspect_ratio } = req.body;
    if (!name) return res.status(400).json({ error: 'App name required' });

    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const app_id = `${baseSlug}-${randomSuffix}`;

    try {
        const newApp = {
            developerId: req.user.id,
            app_id,
            name,
            category: category || 'Utilities',
            description: description || 'No description provided.',
            price: price || 0,
            icon_url: icon_url || '',
            aspect_ratio: aspect_ratio || '9 / 20',
            created_at: new Date()
        };
        await apps.insertOne(newApp);
        res.status(201).json({ success: true, app_id });
    } catch (err) { res.status(500).json({ error: 'Failed to register app' }); }
});

app.put('/api/apps/:id', authenticateToken, async (req, res) => {
    const { name, category, description, price, icon_url, aspect_ratio } = req.body;
    try {
        const result = await apps.updateOne(
            { app_id: req.params.id, developerId: req.user.id },
            { $set: { name, category, description, price, icon_url, aspect_ratio } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update app' }); }
});

app.delete('/api/apps/:id', authenticateToken, async (req, res) => {
    try {
        const result = await apps.deleteOne({ app_id: req.params.id, developerId: req.user.id });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete app' }); }
});

// PAYOUTS & TRANSACTIONS (NEW)
app.get('/api/dev/payouts', authenticateToken, async (req, res) => {
    try {
        const txs = await transactions.find({ developerId: req.user.id }).sort({ date: -1 }).toArray();
        
        // Calculate total revenue
        const total_revenue = txs.reduce((sum, tx) => sum + tx.amount, 0);

        const formattedTxs = txs.map(tx => ({
            id: tx._id,
            app_name: tx.app_name,
            amount: tx.amount,
            date: tx.date,
            status: tx.status
        }));

        res.json({ total_revenue, transactions: formattedTxs });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payouts' }); }
});

// STOREFRONT API
app.get('/api/storefront/apps', async (req, res) => {
    try {
        const allApps = await apps.find({}).toArray();
        const publicApps = allApps.map(app => ({
            app_id: app.app_id,
            name: app.name,
            category: app.category || 'App',
            description: app.description || 'Check out this app on FlipStack.',
            price: app.price || 0,
            icon_url: app.icon_url || '',
            aspect_ratio: app.aspect_ratio || '9 / 20'
        }));
        res.json({ apps: publicApps });
    } catch (err) { res.status(500).json({ error: 'Failed to load storefront apps' }); }
});

// THE FLIPPER: CHECKOUT INITIATION (UPDATED FOR GLOBAL KEYS)
app.post('/api/checkout/initiate', async (req, res) => {
    const { app_id, email, user_id } = req.body;
    if (!app_id || !email || !user_id) return res.status(400).json({ error: 'Missing fields' });

    try {
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord) return res.status(404).json({ error: 'App not found' });
        if (appRecord.price <= 0) return res.status(400).json({ error: 'This app is free' });

        // Look up the developer to get the Global Secret Key
        const dev = await developers.findOne({ _id: new ObjectId(appRecord.developerId) });
        
        // Fallback: Use dev's global key, or the app's specific key if it exists
        const secretKey = dev?.paystack_secret_key || appRecord.paystack_secret;

        if (!secretKey) {
            return res.status(400).json({ error: 'Developer has not configured a Paystack Secret Key.' });
        }

        const payload = {
            email: email,
            amount: appRecord.price, 
            metadata: {
                app_id: app_id,
                user_id: user_id,
                custom_fields: [{ display_name: "App Name", variable_name: "app_name", value: appRecord.name }]
            }
        };

        const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
            headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
        });

        res.json({ success: true, access_code: paystackResponse.data.data.access_code });
    } catch (err) {
        console.error('Paystack Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize checkout' });
    }
});

// WEBHOOK & ENTITLEMENT
app.post('/webhook/:app_id', async (req, res) => {
    const developer = await apps.findOne({ app_id: req.params.app_id });
    if (!developer) return res.status(404).send('App not found');
    
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');
    
    // Look up dev for global secret, fallback to app secret
    const dev = await developers.findOne({ _id: new ObjectId(developer.developerId) });
    const secretKey = dev?.paystack_secret_key || developer.paystack_secret;

    if (!secretKey) return res.status(500).send('No key configured');

    const expectedSignature = crypto.createHmac('sha512', secretKey).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return res.status(401).send('Invalid signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const userId = event.data.metadata?.user_id;
        const amount = event.data.amount / 100; // Convert to standard currency (Rands/Dollars)
        
        if (userId) {
            // 1. Upsert Entitlement (Unlock Pro)
            await entitlements.updateOne(
                { app_id: req.params.app_id, user_id: userId }, 
                { $set: { tier: 'pro', updated_at: new Date() } }, 
                { upsert: true }
            );

            // 2. Log Transaction for Developer Dashboard
            await transactions.insertOne({
                developerId: developer.developerId,
                app_id: req.params.app_id,
                app_name: developer.name,
                user_id: userId,
                amount: amount,
                reference: event.data.reference,
                email: event.data.customer.email,
                status: 'successful',
                date: new Date()
            });

            console.log(`✅ [${developer.name}] Flipped User ${userId} to PRO and logged R${amount}`);
        }
    }
    res.status(200).send('Webhook received');
});

app.get('/api/entitlement', async (req, res) => {
    const { app_id, user_id } = req.query;
    if (!app_id || !user_id) return res.status(400).json({ error: 'Missing params' });
    try {
        const record = await entitlements.findOne({ app_id, user_id });
        res.json({ app_id, user_id, tier: record ? record.tier : 'free' });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

startServer();
