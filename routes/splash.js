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

            // FIXED: Updated to match the .env variable name
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
            
            const dev = await developersCollection.findOne({ _id: new ObjectId(app.developerId) });
            const isStudio = dev && dev.tier === 'studio';
            
            let updateData = {
                splash_status: 'pending',
                splash_rejection_reason: null, // Clear any old rejection reasons
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

    // 4. ADMIN MODERATION PANEL (UPGRADED UI)
    router.get('/admin', async (req, res) => {
        if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(403).send("Unauthorized. Provide ?token=YOUR_ADMIN_TOKEN");

        const pendingApps = await appsCollection.find({ splash_status: 'pending' }).toArray();
        const devIds = pendingApps.map(app => new ObjectId(app.developerId));
        const devs = await developersCollection.find({ _id: { $in: devIds } }).toArray();
        const devMap = {};
        devs.forEach(d => { devMap[d._id.toString()] = d.name; });

        let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>FlipStack - Moderation Queue</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@900&display=swap');
                body { background-color: #0f0f13; color: #ffffff; font-family: system-ui, -apple-system, sans-serif; padding: 2rem; display: flex; flex-direction: column; align-items: center; }
                .header { text-align: center; margin-bottom: 2rem; }
                .logo { font-family: 'Orbitron', sans-serif; font-weight: 900; font-size: 1.8rem; transform: skewX(-10deg); display: inline-block; text-decoration: none; }
                .flip { color: #FF3399; } .stack { color: #00C9A7; }
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem; width: 100%; max-width: 1200px; }
                .card { background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(212, 175, 55, 0.3); border-radius: 16px; padding: 1.5rem; display: flex; flex-direction: column; }
                h2 { margin-bottom: 0.5rem; font-size: 1.2rem; }
                .dev-name { color: #888; font-size: 0.9rem; margin-bottom: 1rem; }
                video { width: 100%; border-radius: 8px; margin-bottom: 1rem; background: #000; }
                .video-label { font-size: 0.8rem; color: #aaa; margin-bottom: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
                .actions { display: flex; gap: 0.5rem; flex-direction: column; margin-top: auto; }
                button { padding: 0.75rem; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; transition: opacity 0.2s; width: 100%; }
                button:hover { opacity: 0.8; }
                .btn-approve { background: #00c853; color: white; }
                .btn-reject { background: #d50000; color: white; }
                .reject-input { width: 100%; padding: 0.75rem; border-radius: 8px; border: 1px solid #444; background: rgba(0,0,0,0.4); color: white; margin-bottom: 0.5rem; display: none; }
                .empty { color: #888; font-size: 1.1rem; margin-top: 2rem; }
            </style>
        </head>
        <body>
            <div class="header">
                <a href="#" class="logo"><span class="flip">Flip</span><span class="stack">Stack</span></a>
                <h2 style="margin-top: 1rem; font-weight: normal; color: #aaa;">Admin Moderation Queue</h2>
                <p style="color: #7c7cff;">Pending Splashes: ${pendingApps.length}</p>
            </div>
            <div class="grid">`;

        if (pendingApps.length === 0) {
            html += `<div class="empty" style="grid-column: 1 / -1;">No pending videos to moderate. You're all caught up!</div>`;
        }

        pendingApps.forEach(app => {
            const devName = devMap[app.developerId] || 'Unknown Developer';
            html += `<div class="card">
                <h2>${app.name}</h2>
                <div class="dev-name">App ID: ${app.app_id} | By: ${devName}</div>`;
            
            if (app.splash_video_url) {
                html += `<div class="video-label">Video A</div><video src="${app.splash_video_url}" controls loop></video>`;
            }
            if (app.splash_video_url_b) {
                html += `<div class="video-label" style="color: #FF3399;">Video B (Studio)</div><video src="${app.splash_video_url_b}" controls loop></video>`;
            }
            
            html += `<div class="actions">
                <form action="/api/splash/admin/action" method="POST" onsubmit="return confirm('Approve this video?');">
                    <input type="hidden" name="token" value="${req.query.token}">
                    <input type="hidden" name="app_id" value="${app.app_id}">
                    <input type="hidden" name="action" value="approve">
                    <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form action="/api/splash/admin/action" method="POST">
                    <input type="hidden" name="token" value="${req.query.token}">
                    <input type="hidden" name="app_id" value="${app.app_id}">
                    <input type="hidden" name="action" value="reject">
                    <input type="text" name="reason" class="reject-input" placeholder="Reason for rejection..." required>
                    <button type="button" class="btn-reject" onclick="const input = this.previousElementSibling; if(input.style.display === 'none' || !input.style.display) { input.style.display = 'block'; input.focus(); this.innerText = 'Confirm Rejection'; } else { if(input.value.trim() === '') { alert('Please provide a reason.'); return; } this.form.submit(); }">Reject</button>
                </form>
            </div></div>`;
        });

        html += `</div></body></html>`;
        res.send(html);
    });

    router.post('/admin/action', express.urlencoded({ extended: true }), async (req, res) => {
        if (req.body.token !== process.env.ADMIN_TOKEN) return res.status(403).send("Unauthorized");
        
        const action = req.body.action;
        const app_id = req.body.app_id;
        
        if (action === 'approve') {
            await appsCollection.updateOne({ app_id: app_id }, { $set: { splash_status: 'approved', splash_rejection_reason: null } });
        } else if (action === 'reject') {
            const reason = req.body.reason || 'Video did not meet guidelines.';
            await appsCollection.updateOne({ app_id: app_id }, { $set: { splash_status: 'rejected', splash_rejection_reason: reason } });
        }
        
        res.redirect(`/api/splash/admin?token=${req.body.token}`);
    });

    return router;
};
