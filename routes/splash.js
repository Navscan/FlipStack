const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ObjectId } = require('mongodb');
const { processSplashVideo } = require('../lib/video');

const splashStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = '/var/www/flipstack-frontend/uploads/splashes/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, `temp_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '')}`);
    }
});

const uploadSplash = multer({
    storage: splashStorage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

module.exports = function(db) {
    const router = express.Router();
    const appsCollection = db.collection('apps');
    const paymentsCollection = db.collection('platform_payments');
    const developersCollection = db.collection('developers');

    // 1. INITIATE PAYMENT (R199)
    router.post('/initiate', async (req, res) => {
        try {
            const { app_id, email } = req.body;
            if (!app_id || !email) return res.status(400).json({ error: "Missing app_id or email" });

            const paystackSecret = process.env.FLIPSTACK_PAYSTACK_SECRET;
            if (!paystackSecret) return res.status(500).json({ error: "Platform Paystack key not configured" });
            
            const response = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${paystackSecret}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: email,
                    amount: 19900,
                    callback_url: `https://flipstack.store/dashboard.html`,
                    metadata: { app_id: app_id, type: 'splash_upgrade' }
                })
            });

            const data = await response.json();
            if (!data.status) throw new Error(data.message);

            res.json({ success: true, authorization_url: data.data.authorization_url, reference: data.data.reference });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 2. VERIFY PAYMENT
    router.get('/verify', async (req, res) => {
        try {
            const { reference } = req.query;
            if (!reference) return res.status(400).json({ error: "Missing reference" });
            
            const paystackSecret = process.env.FLIPSTACK_PAYSTACK_SECRET;
            const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
                headers: { 'Authorization': `Bearer ${paystackSecret}` }
            });
            const data = await response.json();
            
            if (!data.status || data.data.status !== 'success') {
                return res.status(400).json({ error: "Payment verification failed" });
            }
            
            const app_id = data.data.metadata.app_id;
            
            await paymentsCollection.insertOne({
                app_id: app_id,
                amount: 19900,
                reference: reference,
                email: data.data.customer.email,
                status: 'success',
                date: new Date(),
                type: 'splash_upgrade'
            });

            await appsCollection.updateOne(
                { app_id: app_id },
                { $set: { splash_paid: true } }
            );

            res.json({ success: true, message: "Payment verified. Splash unlocked." });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 3. UPLOAD & PROCESS VIDEO
    router.post('/upload/:app_id', uploadSplash.fields([
        { name: 'splash_video_a', maxCount: 1 },
        { name: 'splash_video_b', maxCount: 1 }
    ]), async (req, res) => {
        let tempPathA = null;
        let tempPathB = null;
        try {
            const app_id = req.params.app_id;
            if (!req.files || (!req.files['splash_video_a'] && !req.files['splash_video_b'])) {
                return res.status(400).json({ error: "No video files provided" });
            }
            
            const app = await appsCollection.findOne({ app_id: app_id });
            if (!app) return res.status(404).json({ error: "App not found" });
            if (!app.splash_paid) return res.status(403).json({ error: "Splash feature not purchased for this app" });
            
            const dev = await developersCollection.findOne({ _id: new ObjectId(app.developerId) });
            const isStudio = dev && dev.tier === 'studio';
            
            let updateData = {
                splash_status: 'pending',
                splash_rejection_reason: null,
                splash_video_updated_at: new Date()
            };

            if (req.files['splash_video_a']) {
                tempPathA = req.files['splash_video_a'][0].path;
                const finalFilenameA = `${app_id}_splash_A.mp4`;
                const finalPathA = path.join('/var/www/flipstack-frontend/uploads/splashes/', finalFilenameA);
                const resultA = await processSplashVideo(tempPathA, finalPathA);
                updateData.splash_video_url = `https://flipstack.store/uploads/splashes/${finalFilenameA}`;
                updateData.splash_duration_ms = resultA.duration_ms;
                updateData.splash_size_bytes = resultA.size_bytes;
            }
            
            if (isStudio && req.files['splash_video_b']) {
                tempPathB = req.files['splash_video_b'][0].path;
                const finalFilenameB = `${app_id}_splash_B.mp4`;
                const finalPathB = path.join('/var/www/flipstack-frontend/uploads/splashes/', finalFilenameB);
                await processSplashVideo(tempPathB, finalPathB);
                updateData.splash_video_url_b = `https://flipstack.store/uploads/splashes/${finalFilenameB}`;
            }
            
            await appsCollection.updateOne(
                { app_id: app_id },
                { $set: updateData }
            );
            
            res.json({ success: true, message: "Video(s) uploaded and pending moderation." });
        } catch (error) {
            if (tempPathA && fs.existsSync(tempPathA)) fs.unlinkSync(tempPathA);
            if (tempPathB && fs.existsSync(tempPathB)) fs.unlinkSync(tempPathB);
            res.status(400).json({ error: error.message });
        }
    });

    // 4. ADMIN API ENDPOINTS (JSON only, UI is now in admin.html)
    router.get('/admin/pending', async (req, res) => {
        if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: "Unauthorized" });

        try {
            const pendingApps = await appsCollection.find({ splash_status: 'pending' }).toArray();
            const devIds = pendingApps.map(app => new ObjectId(app.developerId));
            const devs = await developersCollection.find({ _id: { $in: devIds } }).toArray();
            
            const devMap = {};
            devs.forEach(d => { devMap[d._id.toString()] = d.name; });

            const formattedApps = pendingApps.map(app => ({
                app_id: app.app_id,
                name: app.name,
                developer_name: devMap[app.developerId] || 'Unknown Developer',
                splash_video_url: app.splash_video_url,
                splash_video_url_b: app.splash_video_url_b
            }));

            res.json({ success: true, apps: formattedApps });
        } catch (err) {
            res.status(500).json({ error: "Server error" });
        }
    });

    router.post('/admin/action', express.json(), async (req, res) => {
        if (req.body.token !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: "Unauthorized" });
        
        const { action, app_id, reason } = req.body;
        
        try {
            if (action === 'approve') {
                await appsCollection.updateOne({ app_id: app_id }, { $set: { splash_status: 'approved', splash_rejection_reason: null } });
            } else if (action === 'reject') {
                await appsCollection.updateOne({ app_id: app_id }, { $set: { splash_status: 'rejected', splash_rejection_reason: reason || 'Video did not meet guidelines.' } });
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Server error" });
        }
    });

    return router;
};
