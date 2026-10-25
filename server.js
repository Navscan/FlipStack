const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. CORS Configuration
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

// 2. CRITICAL: Keep raw body for webhook verification
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

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

        app.listen(PORT, () => {
            console.log(`🚀 FlipStack listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB', err);
    }
}

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
        req.user = user;
        next();
    });
};

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });

    try {
        const existing = await developers.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(password, salt);

        await developers.insertOne({
            email: email.toLowerCase(),
            password: hash,
            name,
            created_at: new Date()
        });

        res.status(201).json({ success: true, message: 'Developer created' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const dev = await developers.findOne({ email: email.toLowerCase() });
        if (!dev) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, dev.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const accessToken = jwt.sign({ id: dev._id.toString(), email: dev.email }, process.env.JWT_SECRET, { expiresIn: '15m' });
        const refreshToken = jwt.sign({ id: dev._id.toString() }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ 
            accessToken, 
            developer: { id: dev._id, email: dev.email, name: dev.name } 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

app.post('/api/auth/refresh', (req, res) => {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ error: 'No refresh token' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        const accessToken = jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
        res.json({ accessToken });
    } catch (err) {
        res.clearCookie('refreshToken');
        res.status(401).json({ error: 'Invalid refresh token' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('refreshToken');
    res.json({ success: true });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        if (!dev) return res.status(404).json({ error: 'Developer not found' });
        res.json({ developer: { id: dev._id, email: dev.email, name: dev.name } });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// APP MANAGEMENT ROUTES (PROTECTED)
// ==========================================
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
    } catch (err) {
        console.error('Fetch apps error:', err);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

app.post('/api/apps', authenticateToken, async (req, res) => {
    const { name, paystack_secret } = req.body;
    if (!name || !paystack_secret) {
        return res.status(400).json({ error: 'Name and paystack_secret are required' });
    }

    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const app_id = `${baseSlug}-${randomSuffix}`;

    try {
        const newApp = {
            developerId: req.user.id,
            app_id,
            name,
            paystack_secret,
            created_at: new Date()
        };

        await apps.insertOne(newApp);

        console.log(`✅ [${req.user.email}] Registered new app: ${name} (${app_id})`);

        res.status(201).json({
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
// PUBLIC STOREFRONT ROUTE
// ==========================================
app.get('/api/storefront/apps', async (req, res) => {
    try {
        const allApps = await apps.find({}).toArray();
        
        // Strip out secrets and developer IDs
        const publicApps = allApps.map(app => ({
            app_id: app.app_id,
            name: app.name
            // Later we will add: category, description, price, icon_url
        }));

        res.json({ apps: publicApps });
    } catch (err) {
        console.error('Storefront error:', err);
        res.status(500).json({ error: 'Failed to load storefront apps' });
    }
});

// ==========================================
// PUBLIC WEBHOOK & ENTITLEMENT (THE FLIPPER)
// ==========================================
app.post('/webhook/:app_id', async (req, res) => {
    const appId = req.params.app_id;
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
