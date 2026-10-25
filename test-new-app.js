const crypto = require('crypto');

async function runTest() {
    const secret = 'sk_test_54b4b0d35c5fb513ab604a761481ddc13ac60e0b'; 
    const appId = 'super-cool-game-f45c'; // The new app we just registered
    const userId = 'player_99';

    // 1. Check status BEFORE
    let res = await fetch(`http://localhost:3000/api/entitlement?app_id=${appId}&user_id=${userId}`);
    let data = await res.json();
    console.log(`1. Initial Status: ${data.tier.toUpperCase()} (Expect FREE)`);

    // 2. Send webhook
    const payload = { event: 'charge.success', data: { metadata: { user_id: userId } } };
    const payloadString = JSON.stringify(payload);
    const signature = crypto.createHmac('sha512', secret).update(payloadString).digest('hex');

    await fetch(`http://localhost:3000/webhook/${appId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
        body: payloadString
    });
    console.log('2. Webhook sent to super-cool-game');

    // 3. Check status AFTER
    res = await fetch(`http://localhost:3000/api/entitlement?app_id=${appId}&user_id=${userId}`);
    data = await res.json();
    console.log(`3. Final Status: ${data.tier.toUpperCase()} (Expect PRO)`);
}

runTest().catch(console.error);