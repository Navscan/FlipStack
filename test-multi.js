const crypto = require('crypto');
require('dotenv').config();

const secret = process.env.PAYSTACK_SECRET_KEY;
const appId = 'neatly-app';
const userId = 'multi_user_1';

async function runTest() {
    // 1. Check status BEFORE payment
    let res = await fetch(`http://localhost:3000/api/entitlement?app_id=${appId}&user_id=${userId}`);
    let data = await res.json();
    console.log(`1. Initial Status: ${data.tier.toUpperCase()} (Expect FREE)`);

    // 2. Send the Paystack Webhook (The payment happens)
    const payload = { event: 'charge.success', data: { metadata: { user_id: userId } } };
    const payloadString = JSON.stringify(payload);
    const signature = crypto.createHmac('sha512', secret).update(payloadString).digest('hex');

    await fetch(`http://localhost:3000/webhook/${appId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
        body: payloadString
    });
    console.log('2. Webhook sent (Payment processed)');

    // 3. Check status AFTER payment
    res = await fetch(`http://localhost:3000/api/entitlement?app_id=${appId}&user_id=${userId}`);
    data = await res.json();
    console.log(`3. Final Status: ${data.tier.toUpperCase()} (Expect PRO)`);
}

runTest().catch(console.error);