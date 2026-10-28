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

    // 1. INITIATE PAYMENT (R199)
    router.post('/initiate', async (req, res) => {
        try {
            const { app_id, email } = req.body;
            if (!app_id || !email) return res.status(400).json({ error: "Missing app_id or email" });

            const paystackSecret = process.env.FLIPSTACK_PAYSTACK_SECRET_KEY;
            if (!paystackSecret) return res.status(500).json({ error: "Platform Paystack key not configured" });

            const response = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${paystackSecret}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: email,
                    amount: 19900, // R199 in cents
                    callback_url: `https://flipstack.store/dashboard.html`, // UPDATED URL
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

    // 2. VERIFY PAYMENT (After redirect)
    router.get('/verify', async (req, res) => {
        try {
            const { reference } = req.query;
            if (!reference) return res.status(400).json({ error: "Missing reference" });

            const paystackSecret = process.env.FLIPSTACK_PAYSTACK_SECRET_KEY;
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
    router.post('/upload/:app_id', uploadSplash.single('splash_video'), async (req, res) => {
        let tempPath = null;
        try {
            const app_id = req.params.app_id;
            if (!req.file) return res.status(400).json({ error: "No video file provided" });
            
            tempPath = req.file.path;

            const app = await appsCollection.findOne({ app_id: app_id });
            if (!app) return res.status(404).json({ error: "App not found" });
            if (!app.splash_paid) return res.status(403).json({ error: "Splash feature not purchased for this app" });

            const finalFilename = `${app_id}_splash.mp4`;
            const finalPath = path.join('/var/www/flipstack-frontend/uploads/splashes/', finalFilename);
            const videoUrl = `https://flipstack.store/uploads/splashes/${finalFilename}`; // UPDATED URL

            const result = await processSplashVideo(tempPath, finalPath);

            await appsCollection.updateOne(
                { app_id: app_id },
                { 
                    $set: { 
                        splash_video_url: videoUrl,
                        splash_status: 'pending', 
                        splash_video_updated_at: new Date(),
                        splash_duration_ms: result.duration_ms,
                        splash_size_bytes: result.size_bytes
                    } 
                }
            );

            res.json({ success: true, message: "Video uploaded and pending moderation.", url: videoUrl });
        } catch (error) {
            if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            res.status(400).json({ error: error.message });
        }
    });

    // 4. ADMIN MODERATION PANEL
    router.get('/admin', async (req, res) => {
        if (req.query.token !== process.env.ADMIN_TOKEN) {
            return res.status(403).send("Unauthorized");
        }

        const pendingApps = await appsCollection.find({ splash_status: 'pending' }).toArray();
        
        let html = `
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { background: #0f0f13; color: #fff; font-family: sans-serif; padding: 20px; }
                .card { background: #1c1c24; padding: 15px; margin-bottom: 20px; border-radius: 10px; }
                video { width: 100%; max-width: 400px; border-radius: 8px; margin-bottom: 10px; }
                button { padding: 10px 20px; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; margin-right: 10px; }
                .approve { background: #00c853; color: white; }
                .reject { background: #d50000; color: white; }
            </style>
        </head>
        <body>
            <h2>Moderation Queue</h2>
            <p>Pending Splashes: ${pendingApps.length}</p>
        `;

        pendingApps.forEach(app => {
            html += `
            <div class="card">
                <h3>${app.name} (${app.app_id})</h3>
                <video src="${app.splash_video_url}" controls autoplay loop muted></video>
                <br>
                <form action="/api/splash/admin/action" method="POST" style="display:inline;">
                    <input type="hidden" name="token" value="${req.query.token}">
                    <input type="hidden" name="app_id" value="${app.app_id}">
                    <input type="hidden" name="action" value="approve">
                    <button type="submit" class="approve">Approve</button>
                </form>
                <form action="/api/splash/admin/action" method="POST" style="display:inline;">
                    <input type="hidden" name="token" value="${req.query.token}">
                    <input type="hidden" name="app_id" value="${app.app_id}">
                    <input type="hidden" name="action" value="reject">
                    <button type="submit" class="reject">Reject</button>
                </form>
            </div>
            `;
        });

        html += `</body></html>`;
        res.send(html);
    });

    // 5. ADMIN ACTION (Approve/Reject)
    router.post('/admin/action', express.urlencoded({ extended: true }), async (req, res) => {
        if (req.body.token !== process.env.ADMIN_TOKEN) {
            return res.status(403).send("Unauthorized");
        }

        const { app_id, action } = req.body;
        const newStatus = action === 'approve' ? 'approved' : 'rejected';

        await appsCollection.updateOne(
            { app_id: app_id },
            { $set: { splash_status: newStatus } }
        );

        res.redirect(`/api/splash/admin?token=${req.body.token}`);
    });

    return router;
};
