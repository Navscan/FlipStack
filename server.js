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

const splashRoutes = require('./routes/splash');
const { encrypt, decrypt } = require('./lib/crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const apkDir = '/var/www/flipstack-frontend/uploads/apks';
const iconDir = '/var/www/flipstack-frontend/uploads/icons';
const screenshotDir = '/var/www/flipstack-frontend/uploads/screenshots';
if (!fs.existsSync(apkDir)) fs.mkdirSync(apkDir, { recursive: true });
if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, '/var/www/flipstack-frontend/uploads/'); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(cors({
    origin: ['https://flipstack.store', 'https://www.flipstack.store'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const client = new MongoClient(process.env.MONGODB_URI);
let db, entitlements, apps, developers, transactions, analytics_views;

const checkApiLimit = async (req, res, next) => {
    try {
        const { app_id } = req.query;
        if (!app_id) return next();
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord) return res.status(404).json({ error: 'App not found' });
        const dev = await developers.findOne({ _id: new ObjectId(appRecord.developerId) });
        if (!dev) return res.status(404).json({ error: 'Developer not found' });

        const tier = dev.tier || 'free';
        const limit = tier === 'free' ? 1000 : tier === 'pro' ? 5000 : 50000;
        const currentCalls = dev.api_calls_this_month || 0;
        const lastReset = dev.last_api_reset ? new Date(dev.last_api_reset) : new Date();
        const now = new Date();
        let callsToSet = currentCalls;

        if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
            callsToSet = 0;
            await developers.updateOne({ _id: dev._id }, { $set: { api_calls_this_month: 0, last_api_reset: now } });
        }

        if (callsToSet >= limit) return res.status(429).json({ error: `API Limit Reached (${limit}/mo). Upgrade to increase limits.` });
        await developers.updateOne({ _id: dev._id }, { $inc: { api_calls_this_month: 1 } });
        next();
    } catch (err) { next(); }
};

async function startServer() {
    try {
        await client.connect();
        db = client.db('flipstack');
        entitlements = db.collection('entitlements');
        apps = db.collection('apps');
        developers = db.collection('developers');
        transactions = db.collection('transactions');
        analytics_views = db.collection('analytics_views');
        
        app.use('/api/splash', splashRoutes(db));

        app.get('/sitemap.xml', async (req, res) => {
            try {
                const allApps = await apps.find({}).toArray();
                let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
                xml += `    <url>\n        <loc>https://flipstack.store/</loc>\n        <changefreq>daily</changefreq>\n        <priority>1.0</priority>\n    </url>\n`;
                allApps.forEach(app => {
                    xml += `    <url>\n        <loc>https://flipstack.store/app/${app.app_id}</loc>\n        <changefreq>weekly</changefreq>\n        <priority>0.8</priority>\n    </url>\n`;
                });
                xml += `</urlset>`;
                res.header('Content-Type', 'application/xml');
                res.send(xml);
            } catch (error) {
                res.status(500).send('Error generating sitemap');
            }
        });

        app.listen(PORT, () => console.log(`FlipStack listening on port ${PORT}`));
    } catch (err) { console.error('Failed to connect to MongoDB', err); }
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
        await developers.insertOne({ email: email.toLowerCase(), password: hash, name, tier: 'free', api_calls_this_month: 0, last_api_reset: new Date(), created_at: new Date() });
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
        res.json({ accessToken, developer: { id: dev._id, email: dev.email, name: dev.name, tier: dev.tier || 'free' } });
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
        res.json({ developer: { id: dev._id, email: dev.email, name: dev.name, tier: dev.tier || 'free', api_calls_this_month: dev.api_calls_this_month || 0 } });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DEV SETTINGS & KEYS
app.get('/api/dev/keys', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        const encryptedSecret = dev.paystack_secret_key || '';
        const secret = decrypt(encryptedSecret) || '';
        const masked = secret.length > 8 ? `${secret.substring(0, 7)}...${secret.slice(-4)}` : '';
        res.json({ public_key: dev.paystack_public_key || '', secret_key_masked: masked });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dev/keys', authenticateToken, async (req, res) => {
    const { public_key, secret_key } = req.body;
    try {
        const updateFields = { paystack_public_key: public_key };
        if (secret_key && secret_key.trim() !== '') updateFields.paystack_secret_key = encrypt(secret_key);
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

app.post('/api/dev/upgrade-tier', authenticateToken, async (req, res) => {
    const { tier } = req.body;
    if (!['free', 'pro', 'studio'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    try {
        await developers.updateOne({ _id: new ObjectId(req.user.id) }, { $set: { tier: tier } });
        res.json({ success: true, message: `Upgraded to ${tier}` });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/dev/export-csv', authenticateToken, async (req, res) => {
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        if (dev.tier !== 'studio') return res.status(403).json({ error: 'CSV Export is a Studio Tier feature. Please upgrade.' });
        const txs = await transactions.find({ developerId: req.user.id }).sort({ date: -1 }).toArray();
        let csv = 'Date,App Name,Amount (ZAR),Platform Fee (ZAR),Customer Email,Reference,Status\n';
        txs.forEach(tx => {
            const date = new Date(tx.date).toISOString().split('T')[0];
            const fee = tx.platform_fee || 0;
            const appName = `"${tx.app_name.replace(/"/g, '""')}"`;
            const email = `"${tx.email.replace(/"/g, '""')}"`;
            csv += `${date},${appName},${tx.amount},${fee},${email},${tx.reference},${tx.status}\n`;
        });
        res.header('Content-Type', 'text/csv');
        res.attachment(`flipstack-export-${Date.now()}.csv`);
        res.send(csv);
    } catch (err) { res.status(500).json({ error: 'Failed to generate CSV' }); }
});

// APP MANAGEMENT
app.get('/api/apps', authenticateToken, async (req, res) => {
    try {
        const myApps = await apps.find({ developerId: req.user.id }).sort({ created_at: -1 }).toArray();
        const safeApps = myApps.map(app => ({
            id: app._id, app_id: app.app_id, name: app.name,
            webhook_url: `https://api.flipstack.store/webhook/${app.app_id}`,
            category: app.category, description: app.description, price: app.price,
            icon_url: app.icon_url || '', screenshot_url: app.screenshot_url || '',
            aspect_ratio: app.aspect_ratio, app_url: app.app_url || '', created_at: app.created_at,
            splash_paid: app.splash_paid || false, splash_status: app.splash_status || 'none', 
            splash_video_url: app.splash_video_url || '',
            splash_video_url_b: app.splash_video_url_b || ''
        }));
        res.json({ apps: safeApps });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch apps' }); }
});

app.post('/api/apps', authenticateToken, upload.fields([
    { name: 'apk_file', maxCount: 1 }, { name: 'icon_file', maxCount: 1 }, { name: 'screenshot_file', maxCount: 1 }
]), async (req, res) => {
    const { name, category, description, price, aspect_ratio } = req.body;
    if (!name) return res.status(400).json({ error: 'App name required' });
    try {
        const dev = await developers.findOne({ _id: new ObjectId(req.user.id) });
        const devTier = dev.tier || 'free';
        const appCount = await apps.countDocuments({ developerId: req.user.id });
        if (devTier === 'free' && appCount >= 1) return res.status(403).json({ error: 'Free tier limit reached (1 App).' });
        if (devTier === 'pro' && appCount >= 3) return res.status(403).json({ error: 'Pro tier limit reached (3 Apps).' });
        if (devTier === 'studio' && appCount >= 10) return res.status(403).json({ error: 'Studio tier limit reached (10 Apps).' });

        const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const randomSuffix = crypto.randomBytes(2).toString('hex');
        const app_id = `${baseSlug}-${randomSuffix}`;
        let app_url = ''; let icon_url = ''; let screenshot_url = '';

        if (req.files && req.files['apk_file']) {
            const apkFile = req.files['apk_file'][0];
            fs.renameSync(apkFile.path, path.join(apkDir, `${app_id}.apk`));
            app_url = `https://flipstack.store/uploads/apks/${app_id}.apk`;
        }
        if (req.files && req.files['icon_file']) {
            const iconFile = req.files['icon_file'][0];
            const finalIconPath = path.join(iconDir, `${app_id}.png`);
            await sharp(iconFile.path).resize(460, 460, { fit: 'inside', withoutEnlargement: true }).extend({ top: 26, bottom: 26, left: 26, right: 26, background: { r: 15, g: 15, b: 19, alpha: 1 } }).png().toFile(finalIconPath);
            fs.unlinkSync(iconFile.path);
            icon_url = `https://flipstack.store/uploads/icons/${app_id}.png`;
        }
        if (req.files && req.files['screenshot_file']) {
            const ssFile = req.files['screenshot_file'][0];
            const finalSsPath = path.join(screenshotDir, `${app_id}.jpg`);
            await sharp(ssFile.path).resize(1080, 2400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(finalSsPath);
            fs.unlinkSync(ssFile.path);
            screenshot_url = `https://flipstack.store/uploads/screenshots/${app_id}.jpg`;
        }

        const newApp = {
            developerId: req.user.id, app_id, name, category: category || 'Utilities', description: description || 'No description.',
            price: price || 0, icon_url: icon_url, screenshot_url: screenshot_url, aspect_ratio: aspect_ratio || '9 / 20', app_url: app_url, created_at: new Date()
        };
        await apps.insertOne(newApp);
        res.status(201).json({ success: true, app_id });
    } catch (err) { res.status(500).json({ error: 'Failed to register app' }); }
});

app.put('/api/apps/:id', authenticateToken, upload.fields([
    { name: 'apk_file', maxCount: 1 }, { name: 'icon_file', maxCount: 1 }, { name: 'screenshot_file', maxCount: 1 }
]), async (req, res) => {
    let updateFields = {};
    if (req.body.name !== undefined) updateFields.name = req.body.name;
    if (req.body.category !== undefined) updateFields.category = req.body.category;
    if (req.body.description !== undefined) updateFields.description = req.body.description;
    if (req.body.price !== undefined) updateFields.price = Number(req.body.price);
    if (req.body.aspect_ratio !== undefined) updateFields.aspect_ratio = req.body.aspect_ratio;

    try {
        if (req.files && req.files['apk_file']) {
            const apkFile = req.files['apk_file'][0];
            fs.renameSync(apkFile.path, path.join(apkDir, `${req.params.id}.apk`));
            updateFields.app_url = `https://flipstack.store/uploads/apks/${req.params.id}.apk`;
        }
        if (req.files && req.files['icon_file']) {
            const iconFile = req.files['icon_file'][0];
            await sharp(iconFile.path).resize(460, 460, { fit: 'inside', withoutEnlargement: true }).extend({ top: 26, bottom: 26, left: 26, right: 26, background: { r: 15, g: 15, b: 19, alpha: 1 } }).png().toFile(path.join(iconDir, `${req.params.id}.png`));
            fs.unlinkSync(iconFile.path);
            updateFields.icon_url = `https://flipstack.store/uploads/icons/${req.params.id}.png`;
        }
        if (req.files && req.files['screenshot_file']) {
            const ssFile = req.files['screenshot_file'][0];
            await sharp(ssFile.path).resize(1080, 2400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(path.join(screenshotDir, `${req.params.id}.jpg`));
            fs.unlinkSync(ssFile.path);
            updateFields.screenshot_url = `https://flipstack.store/uploads/screenshots/${req.params.id}.jpg`;
        }

        if (Object.keys(updateFields).length > 0) {
            const result = await apps.updateOne({ app_id: req.params.id, developerId: req.user.id }, { $set: updateFields });
            if (result.matchedCount === 0) return res.status(404).json({ error: 'App not found' });
        }
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

app.get('/api/dev/payouts', authenticateToken, async (req, res) => {
    try {
        const txs = await transactions.find({ developerId: req.user.id }).sort({ date: -1 }).toArray();
        const total_revenue = txs.reduce((sum, tx) => sum + tx.amount, 0);
        const total_platform_fees = txs.reduce((sum, tx) => sum + (tx.platform_fee || 0), 0);
        const formattedTxs = txs.map(tx => ({ id: tx._id, app_name: tx.app_name, amount: tx.amount, platform_fee: tx.platform_fee || 0, date: tx.date, status: tx.status }));
        res.json({ total_revenue, total_platform_fees, transactions: formattedTxs });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payouts' }); }
});

// --- ANALYTICS ENGINE ---
app.post('/api/analytics/track', async (req, res) => {
    const { app_id, variant } = req.body;
    if (!app_id) return res.status(400).send();
    try {
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord) return res.status(404).send();
        
        const date = new Date().toISOString().split('T')[0];
        
        let incField = { count: 1 };
        if (variant === 'A') incField['variant_a_clicks'] = 1;
        if (variant === 'B') incField['variant_b_clicks'] = 1;

        await analytics_views.updateOne(
            { app_id, date },
            { 
                $inc: incField, 
                $setOnInsert: { developerId: appRecord.developerId, count: 0, variant_a_clicks: 0, variant_b_clicks: 0 } 
            },
            { upsert: true }
        );
        res.status(200).send();
    } catch (err) { res.status(500).send(); }
});

app.get('/api/dev/analytics', authenticateToken, async (req, res) => {
    try {
        const devId = req.user.id;
        const txs = await transactions.find({ developerId: devId }).toArray();
        const totalSales = txs.length;
        const totalRevenue = txs.reduce((sum, tx) => sum + tx.amount, 0);
        const views = await analytics_views.find({ developerId: devId }).toArray();
        
        const totalViews = views.reduce((sum, v) => sum + (v.count || 0), 0);
        const totalVariantA = views.reduce((sum, v) => sum + (v.variant_a_clicks || 0), 0);
        const totalVariantB = views.reduce((sum, v) => sum + (v.variant_b_clicks || 0), 0);

        const conversionRate = totalViews === 0 ? 0 : ((totalSales / totalViews) * 100).toFixed(2);

        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const dayViews = views.filter(v => v.date === dateStr).reduce((sum, v) => sum + (v.count || 0), 0);
            last7Days.push({ date: dateStr, views: dayViews });
        }

        res.json({ totalViews, totalSales, totalRevenue, conversionRate, last7Days, totalVariantA, totalVariantB });
    } catch (err) { res.status(500).json({ error: 'Analytics error' }); }
});

// STOREFRONT API (Sorted by Category Strip Order)
app.get('/api/storefront/apps', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const allApps = await apps.find({}).toArray();
        
        // Define the exact order of the strip menu
        const categoryWeights = {
            "Games": 1, "Education": 2, "Music": 3, "Utilities": 4, 
            "Productivity": 5, "Calculators": 6, "Tools": 7, 
            "Photography": 8, "Health": 9, "Finance": 10, 
            "Developer Tools": 11, "Creative & Design": 12, 
            "Lifestyle & Wellness": 13, "Social & Niche": 14
        };

        // Sort by category weight, falling back to newest first if categories match
        allApps.sort((a, b) => {
            const weightA = categoryWeights[a.category] || 999;
            const weightB = categoryWeights[b.category] || 999;
            if (weightA !== weightB) return weightA - weightB;
            return new Date(b.created_at) - new Date(a.created_at);
        });

        const publicApps = allApps.map(app => ({
            app_id: app.app_id, name: app.name, category: app.category || 'App', description: app.description || '', price: app.price || 0,
            icon_url: app.icon_url || '', screenshot_url: app.screenshot_url || '', aspect_ratio: app.aspect_ratio || '9 / 20', app_url: app.app_url || '',
            splash_video_url: app.splash_video_url || '', 
            splash_video_url_b: app.splash_video_url_b || '', 
            splash_status: app.splash_status || 'none'
        }));
        res.json({ apps: publicApps });
    } catch (err) { res.status(500).json({ error: 'Failed to load storefront apps' }); }
});

app.get('/api/storefront/app/:app_id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const appRecord = await apps.findOne({ app_id: req.params.app_id });
        if (!appRecord) return res.status(404).json({ error: 'App not found' });
        
        const dev = await developers.findOne({ _id: new ObjectId(appRecord.developerId) });
        const devName = dev ? dev.name : 'Indie Developer';

        res.json({ 
            app: {
                app_id: appRecord.app_id, name: appRecord.name, category: appRecord.category || 'App', description: appRecord.description || '', price: appRecord.price || 0,
                icon_url: appRecord.icon_url || '', screenshot_url: appRecord.screenshot_url || '', aspect_ratio: appRecord.aspect_ratio || '9 / 20', app_url: appRecord.app_url || '',
                splash_video_url: appRecord.splash_video_url || '', 
                splash_video_url_b: appRecord.splash_video_url_b || '',
                splash_status: appRecord.splash_status || 'none', created_at: appRecord.created_at,
                developer_name: devName
            }
        });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/checkout/initiate', async (req, res) => {
    const { app_id, email, user_id } = req.body;
    if (!app_id || !email || !user_id) return res.status(400).json({ error: 'Missing fields' });
    try {
        const appRecord = await apps.findOne({ app_id });
        if (!appRecord || appRecord.price <= 0) return res.status(400).json({ error: 'Invalid app or price is 0' });
        
        const dev = await developers.findOne({ _id: new ObjectId(appRecord.developerId) });
        const secretKey = decrypt(dev?.paystack_secret_key || appRecord.paystack_secret);
        
        if (!secretKey || !secretKey.startsWith('sk_')) {
            return res.status(400).json({ error: 'Developer Paystack key is missing or invalid. Please contact the developer.' });
        }

        const payload = { email, amount: appRecord.price, metadata: { app_id, user_id, custom_fields: [{ display_name: "App Name", variable_name: "app_name", value: appRecord.name }] } };
        const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize', payload, { headers: { Authorization: `Bearer ${secretKey}` } });
        res.json({ success: true, access_code: paystackResponse.data.data.access_code });
        
    } catch (err) { 
        const paystackError = err.response?.data?.message || err.message;
        res.status(500).json({ error: `Payment Gateway Error: ${paystackError}` }); 
    }
});

app.get('/api/entitlement', checkApiLimit, async (req, res) => {
    const { app_id, user_id } = req.query;
    if (!app_id || !user_id) return res.status(400).json({ error: 'Missing params' });
    try {
        const record = await entitlements.findOne({ app_id, user_id });
        res.json({ app_id, user_id, tier: record ? record.tier : 'free' });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/entitlement/batch', checkApiLimit, async (req, res) => {
    const { user_id, app_ids } = req.body;
    if (!user_id || !Array.isArray(app_ids)) return res.status(400).json({ error: 'Missing fields' });
    try {
        const proRecords = await entitlements.find({ user_id, tier: 'pro' }).toArray();
        const entitlementsMap = {};
        proRecords.forEach(record => { entitlementsMap[record.app_id] = 'pro'; });
        res.json({ entitlements: entitlementsMap });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/dev/simulate-purchase', authenticateToken, async (req, res) => {
    const { app_id, user_id } = req.body;
    if (!app_id || !user_id) return res.status(400).json({ error: 'Missing app_id or user_id' });
    try {
        const appRecord = await apps.findOne({ app_id, developerId: req.user.id });
        if (!appRecord) return res.status(404).json({ error: 'App not found or unauthorized' });
        await entitlements.updateOne({ app_id, user_id }, { $set: { tier: 'pro', updated_at: new Date() } }, { upsert: true });
        await transactions.insertOne({ developerId: req.user.id, app_id, app_name: appRecord.name, user_id, amount: 0, platform_fee: 0, reference: 'DEV_TEST_' + Date.now(), email: req.user.email || 'dev@test.com', status: 'test_successful', date: new Date() });
        res.json({ success: true, message: 'Test purchase simulated' });
    } catch (err) { res.status(500).json({ error: err.message || 'Failed to simulate purchase' }); }
});

app.post('/webhook/:app_id', async (req, res) => {
    const developer = await apps.findOne({ app_id: req.params.app_id });
    if (!developer) return res.status(404).send('App not found');
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');
    const dev = await developers.findOne({ _id: new ObjectId(developer.developerId) });
    const secretKey = decrypt(dev?.paystack_secret_key || developer.paystack_secret);
    if (!secretKey) return res.status(500).send('No key configured');
    const expectedSignature = crypto.createHmac('sha512', secretKey).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return res.status(401).send('Invalid signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const userId = event.data.metadata?.user_id;
        const amount = event.data.amount / 100;
        const platform_fee = amount * 0.10;
        if (userId) {
            await entitlements.updateOne({ app_id: req.params.app_id, user_id: userId }, { $set: { tier: 'pro', updated_at: new Date() } }, { upsert: true });
            await transactions.insertOne({ developerId: developer.developerId, app_id: req.params.app_id, app_name: developer.name, user_id: userId, amount, platform_fee, reference: event.data.reference, email: event.data.customer.email, status: 'successful', date: new Date() });
            console.log(`[${developer.name}] Sold User ${userId} for R${amount}. Fee: R${platform_fee}`);
        }
    }
    res.status(200).send('Webhook received');
});

startServer();
