const crypto = require('crypto');
require('dotenv').config();

// The secret key from your .env file
const secret = process.env.PAYSTACK_SECRET_KEY;

// A fake Paystack payload (like a user buying "Pro")
const payload = {
    event: 'charge.success',
    data: {
        amount: 15000, // R150.00 (in kobo/cents)
        currency: 'ZAR',
        reference: 'test_ref_123',
        metadata: {
            app_id: 'neatly-app',
            user_id: 'user_999',
            purchase_id: 'purchase_abc'
        }
    }
};

// Convert payload to string exactly as Paystack does
const payloadString = JSON.stringify(payload);

// Create the HMAC-SHA512 signature
const signature = crypto
    .createHmac('sha512', secret)
    .update(payloadString)
    .digest('hex');

// Send the request to your local server
fetch('http://localhost:3000/webhook', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature
    },
    body: payloadString
})
.then(res => res.text())
.then(text => console.log('Server Response:', text))
.catch(err => console.error('Error:', err));