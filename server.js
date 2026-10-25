const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🚨 CRITICAL: Paystack requires the RAW body to verify the signature.
// If Express parses the JSON before we check the signature, the bytes change and it will fail.
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// The Webhook Endpoint
app.post('/webhook', (req, res) => {
    // 1. Get the signature from the headers
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
        return res.status(400).send('No signature provided');
    }

    // 2. Get the secret key (In production, you will look this up based on the app_id in the URL/body)
    const secret = process.env.PAYSTACK_SECRET_KEY;

    // 3. Compute the expected signature using HMAC-SHA512 over the RAW body
    const expectedSignature = crypto
        .createHmac('sha512', secret)
        .update(req.rawBody)
        .digest('hex');

    // 4. Compare securely (timingSafeEqual prevents timing attacks)
    const isVerified = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );

    if (!isVerified) {
        console.warn('❌ Invalid signature attempt');
        return res.status(401).send('Invalid signature');
    }

    // 5. Signature is valid! Process the event
    const event = req.body;
    
    if (event.event === 'charge.success') {
        const data = event.data;
        
        // Extract the metadata you passed during checkout
        const metadata = data.metadata || {};
        const appId = metadata.app_id;
        const userId = metadata.user_id;
        const purchaseId = metadata.purchase_id;

        console.log(`✅ Payment verified for App: ${appId}, User: ${userId}`);
        console.log(`💰 Amount: ${data.amount / 100} ${data.currency}`);

        // 🛑 TODO: Here is where you "Flip" the switch in your database!
        // Example: db.collection('entitlements').updateOne(
        //    { user_id: userId, app_id: appId },
        //    { $set: { tier: 'pro', paid_at: new Date() } }
        // );

    } else {
        console.log(`ℹ️ Received unhandled event: ${event.event}`);
    }

    // 6. Always return 200 OK so Paystack knows you received it and stops retrying
    res.status(200).send('Webhook received');
});

// A simple health check route
app.get('/', (req, res) => {
    res.send('FlipStack Webhook Server is running.');
});

app.listen(PORT, () => {
    console.log(`🚀 FlipStack listening on port ${PORT}`);
});