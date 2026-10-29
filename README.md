# <img src="https://flipstack.store/icon-192.png" width="40" height="40" align="center" /> FlipStack

**The Indie App Store.**
FlipStack is a zero-commission, BYOK (Bring Your Own Key) app store for indie developers. It allows developers to host APKs and PWAs on a sleek, 3D-carousel web storefront, completely bypassing the 15-30% Google Play Store tax.

[**View the Live Store**](https://flipstack.store) • [**List Your App**](https://flipstack.store/signup.html)

## 🚀 How it Works (BYOK Model)
FlipStack uses a strict Zero-Touch Payout model. 
1. Developers create their own free Paystack accounts.
2. They input their Secret Key into the FlipStack dashboard.
3. When an end-user buys an app, the money goes **directly** into the developer's bank account. 
4. FlipStack never touches the money. We act as a SaaS orchestration layer, verifying the webhook to unlock "Pro" features via our API.

## ✨ Features
* **3D Carousel Storefront:** A smooth, mathematically driven 3D carousel built with Vanilla JS.
* **Installable PWA:** The store can be installed directly to an Android home screen.
* **Premium Splash Videos:** Developers can pay a one-time fee to unlock a 5-second splash video that plays when users tap their app.
* **Developer Dashboard:** Full SPA dashboard for managing apps, API keys, analytics, and revenue.
* **Automated SEO:** Dynamic JSON-LD schema and Open Graph tags injected per app page.

## 🛠 Tech Stack
* **Frontend:** Vanilla HTML/CSS/JS (No React, no build tools. Served as a PWA).
* **Backend:** Node.js / Express.
* **Database:** MongoDB.
* **Payments:** Paystack API.
* **Server:** AlmaLinux VPS, Nginx, PM2.

## 🔒 Security
Developer Paystack Secret Keys are encrypted at rest using **AES-256-GCM** before being stored in MongoDB.
