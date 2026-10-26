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
let db, entitlements, apps, developers;

async function startServer() {
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB Atlas');
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');
        apps = db.collection('apps'); 
        developers = db.collection('developers');

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

// APP MANAGEMENT
app.get('/api/apps', authenticateToken, async (req, res) => {
    try {
        const myApps = await apps.find({ developerId: req.user.id }).toArray();
        const safeApps = myApps.map(app => {
            const secret = app.paystack_secret || '';
            const masked = secret.length > 8 ? `${secret.substring(0, 7)}...${secret.slice(-4)}` : '••••••••';
            return {
                id: app._id,
                app_id: app.app_id,
                name: app.name,
                webhook_url: `https://api.flipstack.treasuretrail.africa/webhook/${app.app_id}`,
                paystack_masked: masked,
                created_at: app.created_at
            };
        });
        res.json({ apps: safeApps });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch apps' }); }
});

app.post('/api/apps', authenticateToken, async (req, res) => {
    const { name, paystack_secret, category, description, price, icon_url, aspect_ratio } = req.body;
    if (!name || !paystack_secret) return res.status(400).json({ error: 'Name and paystack_secret required' });

    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const app_id = `${baseSlug}-${randomSuffix}`;

    try {
        const newApp = {
            developerId: req.user.id,
            app_id,
            name,
            paystack_secret,
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

// ==========================================
// THE FLIPPER: CHECKOUT INITIATION
// ==========================================
app.post('/api/checkout/initiate', async (req, res) => {
    const { app_id, email, user_id } = req.body; // ADDED user_id
    
    if (!app_id || !email || !user_id) {
        return res.status(400).json({ error: 'app_id, email, and user_id are required' });
    }

    try {
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord) return res.status(404).json({ error: 'App not found' });
        
        if (appRecord.price <= 0) {
            return res.status(400).json({ error: 'This app is free' });
        }

        const payload = {
            email: email,
            amount: appRecord.price, 
            metadata: {
                app_id: app_id,
                user_id: user_id, // CRITICAL: The webhook needs this to flip the user!
                custom_fields: [
                    {
                        display_name: "App Name",
                        variable_name: "app_name",
                        value: appRecord.name
                    }
                ]
            }
        };

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            payload,
            {
                headers: {
                    Authorization: `Bearer ${appRecord.paystack_secret}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            access_code: paystackResponse.data.data.access_code,
            authorization_url: paystackResponse.data.data.authorization_url
        });

    } catch (err) {
        console.error('Paystack Initiation Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize checkout with Paystack' });
    }
});

// WEBHOOK & ENTITLEMENT
app.post('/webhook/:app_id', async (req, res) => {
    const developer = await apps.findOne({ app_id: req.params.app_id });
    if (!developer) return res.status(404).send('App not found');
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');
    const expectedSignature = crypto.createHmac('sha512', developer.paystack_secret).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return res.status(401).send('Invalid signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const userId = event.data.metadata?.user_id;
        if (userId) {
            await entitlements.updateOne({ app_id: req.params.app_id, user_id: userId }, { $set: { tier: 'pro', updated_at: new Date() } }, { upsert: true });
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
