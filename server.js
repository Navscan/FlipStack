const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
const apkDir = '/var/www/flipstack-frontend/uploads/apks';
const iconDir = '/var/www/flipstack-frontend/uploads/icons';
const screenshotDir = '/var/www/flipstack-frontend/uploads/screenshots';
if (!fs.existsSync(apkDir)) fs.mkdirSync(apkDir, { recursive: true });
if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, '/var/www/flipstack-frontend/uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

app.use(cors({
    origin: ['https://flipstack.treasuretrail.africa', 'https://www.flipstack.treasuretrail.africa'],
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
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');
        apps = db.collection('apps'); 
        developers = db.collection('developers');
        transactions = db.collection('transactions'); 
        app.listen(PORT, () => console.log(`🚀 FlipStack listening on port ${PORT}`));
    } catch (err) { console.error('❌ Failed to connect to MongoDB', err); }
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
        const accessToken = jwt.sign({ id: dev._id.toString(), email: dev.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
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
        const accessToken = jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
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

// DEV SETTINGS & KEYS
app.get('/api/dev/keys', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        const secret = dev.paystack_secret_key || '';
        const masked = secret.length > 8 ? `${secret.substring(0, 7)}...${secret.slice(-4)}` : '';
        res.json({ public_key: dev.paystack_public_key || '', secret_key_masked: masked });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/keys', authenticateToken, async (req, res) => {
    const { public_key, secret_key } = req.body;
    try {
        const updateFields = { paystack_public_key: public_key };
        if (secret_key && secret_key.trim() !== '') updateFields.paystack_secret_key = secret_key;
        await developers.updateOne({ _id: new ObjectId(req.user.id) }, { $set: updateFields });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/profile', authenticateToken, async (req, res) => {
    const { name, email } = req.body;
    try {
        await developers.updateOne({ _id: new ObjectId(req.user.id) }, { $set: { name, email: email.toLowerCase() } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/password', authenticateToken, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        if (!dev || !(await bcrypt.compare(current_password, dev.password))) return res.status(401).json({ error: 'Incorrect current password' });
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
        const safeApps = myApps.map(app => ({
            id: app._id, app_id: app.app_id, name: app.name,
            webhook_url: `https://api.flipstack.treasuretrail.africa/webhook/${app.app_id}`,
            category: app.category, description: app.description, price: app.price,
            icon_url: app.icon_url || '', 
            screenshot_url: app.screenshot_url || '',
            aspect_ratio: app.aspect_ratio, app_url: app.app_url || '', created_at: app.created_at
        }));
        res.json({ apps: safeApps });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch apps' }); }
});

// CREATE APP
app.post('/api/apps', authenticateToken, upload.fields([
    { name: 'apk_file', maxCount: 1 }, 
    { name: 'icon_file', maxCount: 1 },
    { name: 'screenshot_file', maxCount: 1 }
]), async (req, res) => {
    const { name, category, description, price, aspect_ratio } = req.body;
    if (!name) return res.status(400).json({ error: 'App name required' });
    
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const app_id = `${baseSlug}-${randomSuffix}`;

    let app_url = '';
    let icon_url = '';
    let screenshot_url = '';

    try {
        if (req.files && req.files['apk_file']) {
            const apkFile = req.files['apk_file'][0];
            const finalApkPath = path.join(apkDir, `${app_id}.apk`);
            fs.renameSync(apkFile.path, finalApkPath);
            app_url = `https://flipstack.treasuretrail.africa/uploads/apks/${app_id}.apk`;
        }

        if (req.files && req.files['icon_file']) {
            const iconFile = req.files['icon_file'][0];
            const finalIconPath = path.join(iconDir, `${app_id}.png`);
            await sharp(iconFile.path).resize(512, 512, { fit: 'cover' }).png().toFile(finalIconPath);
            fs.unlinkSync(iconFile.path);
            icon_url = `https://flipstack.treasuretrail.africa/uploads/icons/${app_id}.png`;
        }

        if (req.files && req.files['screenshot_file']) {
            const ssFile = req.files['screenshot_file'][0];
            const finalSsPath = path.join(screenshotDir, `${app_id}.jpg`);
            // Resize to a standard 9:20 poster (1080x2400) or keep aspect
            await sharp(ssFile.path).resize(1080, 2400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(finalSsPath);
            fs.unlinkSync(ssFile.path);
            screenshot_url = `https://flipstack.treasuretrail.africa/uploads/screenshots/${app_id}.jpg`;
        }

        const newApp = { 
            developerId: req.user.id, app_id, name, 
            category: category || 'Utilities', 
            description: description || 'No description.', 
            price: price || 0, 
            icon_url: icon_url, 
            screenshot_url: screenshot_url,
            aspect_ratio: aspect_ratio || '9 / 20', 
            app_url: app_url, 
            created_at: new Date() 
        };
        await apps.insertOne(newApp);
        res.status(201).json({ success: true, app_id });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Failed to register app' }); 
    }
});

// UPDATE APP
app.put('/api/apps/:id', authenticateToken, upload.fields([
    { name: 'apk_file', maxCount: 1 }, 
    { name: 'icon_file', maxCount: 1 },
    { name: 'screenshot_file', maxCount: 1 }
]), async (req, res) => {
    const { name, category, description, price, aspect_ratio } = req.body;
    
    let updateFields = { name, category, description, price, aspect_ratio };
    
    try {
        if (req.files && req.files['apk_file']) {
            const apkFile = req.files['apk_file'][0];
            const finalApkPath = path.join(apkDir, `${req.params.id}.apk`);
            fs.renameSync(apkFile.path, finalApkPath);
            updateFields.app_url = `https://flipstack.treasuretrail.africa/uploads/apks/${req.params.id}.apk`;
        }

        if (req.files && req.files['icon_file']) {
            const iconFile = req.files['icon_file'][0];
            const finalIconPath = path.join(iconDir, `${req.params.id}.png`);
            await sharp(iconFile.path).resize(512, 512, { fit: 'cover' }).png().toFile(finalIconPath);
            fs.unlinkSync(iconFile.path);
            updateFields.icon_url = `https://flipstack.treasuretrail.africa/uploads/icons/${req.params.id}.png`;
        }

        if (req.files && req.files['screenshot_file']) {
            const ssFile = req.files['screenshot_file'][0];
            const finalSsPath = path.join(screenshotDir, `${req.params.id}.jpg`);
            await sharp(ssFile.path).resize(1080, 2400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(finalSsPath);
            fs.unlinkSync(ssFile.path);
            updateFields.screenshot_url = `https://flipstack.treasuretrail.africa/uploads/screenshots/${req.params.id}.jpg`;
        }

        const result = await apps.updateOne({ app_id: req.params.id, developerId: req.user.id }, { $set: updateFields });
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

// PAYOUTS
app.get('/api/dev/payouts', authenticateToken, async (req, res) => {
    try {
        const txs = await transactions.find({ developerId: req.user.id }).sort({ date: -1 }).toArray();
        const total_revenue = txs.reduce((sum, tx) => sum + tx.amount, 0);
        const formattedTxs = txs.map(tx => ({ id: tx._id, app_name: tx.app_name, amount: tx.amount, date: tx.date, status: tx.status }));
        res.json({ total_revenue, transactions: formattedTxs });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payouts' }); }
});

// STOREFRONT API
app.get('/api/storefront/apps', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    try {
        const allApps = await apps.find({}).toArray();
        const publicApps = allApps.map(app => ({
            app_id: app.app_id, name: app.name, category: app.category || 'App', 
            description: app.description || '', price: app.price || 0, 
            icon_url: app.icon_url || '', screenshot_url: app.screenshot_url || '',
            aspect_ratio: app.aspect_ratio || '9 / 20', app_url: app.app_url || ''
        }));
        res.json({ apps: publicApps });
    } catch (err) { res.status(500).json({ error: 'Failed to load storefront apps' }); }
});

// CHECKOUT
app.post('/api/checkout/initiate', async (req, res) => {
    const { app_id, email, user_id } = req.body;
    if (!app_id || !email || !user_id) return res.status(400).json({ error: 'Missing fields' });
    try {
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord || appRecord.price <= 0) return res.status(400).json({ error: 'Invalid app' });
        const dev = await developers.findOne({ _id: new ObjectId(appRecord.developerId) });
        const secretKey = dev?.paystack_secret_key || appRecord.paystack_secret;
        if (!secretKey) return res.status(400).json({ error: 'No Paystack key configured.' });

        const payload = { email, amount: appRecord.price, metadata: { app_id, user_id, custom_fields: [{ display_name: "App Name", variable_name: "app_name", value: appRecord.name }] } };
        const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize', payload, { headers: { Authorization: `Bearer ${secretKey}` } });
        res.json({ success: true, access_code: paystackResponse.data.data.access_code });
    } catch (err) { res.status(500).json({ error: 'Failed to initialize checkout' }); }
});

// BATCH ENTITLEMENT
app.post('/api/entitlement/batch', async (req, res) => {
    const { user_id, app_ids } = req.body;
    if (!user_id || !Array.isArray(app_ids)) return res.status(400).json({ error: 'Missing fields' });
    try {
        const proRecords = await entitlements.find({ user_id, tier: 'pro' }).toArray();
        const entitlementsMap = {};
        proRecords.forEach(record => { entitlementsMap[record.app_id] = 'pro'; });
        res.json({ entitlements: entitlementsMap });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// SIMULATE PURCHASE
app.post('/api/dev/simulate-purchase', authenticateToken, async (req, res) => {
    const { app_id, user_id } = req.body;
    if (!app_id || !user_id) return res.status(400).json({ error: 'Missing app_id or user_id' });
    
    try {
        const appRecord = await apps.findOne({ app_id, developerId: req.user.id });
        if (!appRecord) return res.status(404).json({ error: 'App not found or unauthorized' });

        await entitlements.updateOne({ app_id, user_id }, { $set: { tier: 'pro', updated_at: new Date() } }, { upsert: true });
        await transactions.insertOne({ developerId: req.user.id, app_id, app_name: appRecord.name, user_id, amount: 0, reference: 'DEV_TEST_' + Date.now(), email: req.user.email || 'dev@test.com', status: 'test_successful', date: new Date() });

        res.json({ success: true, message: 'Test purchase simulated' });
    } catch (err) { 
        console.error('Simulation Error:', err);
        res.status(500).json({ error: err.message || 'Failed to simulate purchase' }); 
    }
});

// WEBHOOK & SINGLE ENTITLEMENT
app.post('/webhook/:app_id', async (req, res) => {
    const developer = await apps.findOne({ app_id: req.params.app_id });
    if (!developer) return res.status(404).send('App not found');
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');
    const dev = await developers.findOne({ _id: new ObjectId(developer.developerId) });
    const secretKey = dev?.paystack_secret_key || developer.paystack_secret;
    if (!secretKey) return res.status(500).send('No key configured');

    const expectedSignature = crypto.createHmac('sha512', secretKey).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return res.status(401).send('Invalid signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const userId = event.data.metadata?.user_id;
        const amount = event.data.amount / 100; 
        if (userId) {
            await entitlements.updateOne({ app_id: req.params.app_id, user_id: userId }, { $set: { tier: 'pro', updated_at: new Date() } }, { upsert: true });
            await transactions.insertOne({ developerId: developer.developerId, app_id: req.params.app_id, app_name: developer.name, user_id: userId, amount, reference: event.data.reference, email: event.data.customer.email, status: 'successful', date: new Date() });
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
