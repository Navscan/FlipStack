async function registerApp() {
    const response = await fetch('http://localhost:3000/api/register-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Super Cool Game',
            paystack_secret: 'sk_test_54b4b0d35c5fb513ab604a761481ddc13ac60e0b' 
        })
    });

    const data = await response.json();
    console.log('Registration Response:', data);
}

registerApp().catch(console.error);