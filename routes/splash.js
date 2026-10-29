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

    // 3. UPLOAD & PROCESS VIDEO (Supports A/B Testing for Studio)
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

            // Get developer tier to check if they can upload B
            const dev = await developersCollection.findOne({ _id: new ObjectId(app.developerId) });
            const isStudio = dev && dev.tier === 'studio';

            let updateData = {
                splash_status: 'pending',
                splash_video_updated_at: new Date()
            };

            // Process Video A
            if (req.files['splash_video_a']) {
                tempPathA = req.files['splash_video_a'][0].path;
                const finalFilenameA = `${app_id}_splash_A.mp4`;
                const finalPathA = path.join('/var/www/flipstack-frontend/uploads/splashes/', finalFilenameA);
                const resultA = await processSplashVideo(tempPathA, finalPathA);
                
                updateData.splash_video_url = `https://flipstack.store/uploads/splashes/${finalFilenameA}`;
                updateData.splash_duration_ms = resultA.duration_ms;
                updateData.splash_size_bytes = resultA.size_bytes;
            }

            // Process Video B (Only if Studio tier)
            if (isStudio && req.files['splash_video_b']) {
                tempPathB = req.files['splash_video_b'][0].path;
                const finalFilenameB = `${app_id}_splash_B.mp4`;
                const finalPathB = path.join('/var/www/flipstack-frontend/uploads/splashes/', finalFilenameB);
                const resultB = await processSplashVideo(tempPathB, finalPathB);
                
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

    // 4. ADMIN MODERATION PANEL
    router.get('/admin', async (req, res) => {
        if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(403).send("Unauthorized");

        const pendingApps = await appsCollection.find({ splash_status: 'pending' }).toArray();
        
        let html = `
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>body{background:#0f0f13;color:#fff;font-family:sans-serif;padding:20px}.card{background:#1c1c24;padding:15px;margin-bottom:20px;border-radius:10px}video{width:100%;max-width:400px;border-radius:8px;margin-bottom:10px}button{padding:10px 20px;border:none;border-radius:5px;font-weight:bold;cursor:pointer;margin-right:10px}.approve{background:#00c853;color:white}.reject{background:#d50000;color:white}</style></head><body>
        <h2>Moderation Queue</h2><p>Pending Splashes: ${pendingApps.length}</p>`;

        pendingApps.forEach(app => {
            html += `<div class="card"><h3>${app.name} (${app.app_id})</h3>`;
            
            if (app.splash_video_url) {
                html += `<p>Video A:</p><video src="${app.splash_video_url}" controls autoplay loop muted></video>`;
            }
            if (app.splash_video_url_b) {
                html += `<p>Video B (Studio):</p><video src="${app.splash_video_url_b}" controls autoplay loop muted></video>`;
            }

            html += `<br>
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
                </form></div>`;
        });

        html += `</body></html>`;
        res.send(html);
    });

    router.post('/admin/action', express.urlencoded({ extended: true }), async (req, res) => {
        if (req.body.token !== process.env.ADMIN_TOKEN) return res.status(403).send("Unauthorized");
        const newStatus = req.body.action === 'approve' ? 'approved' : 'rejected';
        await appsCollection.updateOne({ app_id: req.body.app_id }, { $set: { splash_status: newStatus } });
        res.redirect(`/api/splash/admin?token=${req.body.token}`);
    });

    return router;
};
