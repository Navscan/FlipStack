<div align="center">

<img src="https://flipstack.store/icon-192.png" width="60" height="60" align="center" />

<h1>
  <span style="color: #FF3399;">Flip</span><span style="color: #00C9A7;">Stack</span>
</h1>

**The Indie App Store.** 

FlipStack is a zero-commission, BYOK (Bring Your Own Key) app store for indie developers. It allows developers to host APKs and PWAs on a sleek, 3D-carousel web storefront, completely bypassing the 15-30% Google Play Store tax.

<br>

[![View the Live Store](https://img.shields.io/badge/View_the_Live_Store-flipstack.store-FF3399?style=for-the-badge&logo=googlechrome&logoColor=white)](https://flipstack.store)
[![List Your App](https://img.shields.io/badge/List_Your_App-flipstack.store/signup.html-00C9A7?style=for-the-badge&logo=codeigniter&logoColor=white)](https://flipstack.store/signup.html)

<br>

[![Zero Commission](https://img.shields.io/badge/Commission-0%25_on_Sales-4ade80?style=flat-square)](#)
[![BYOK Model](https://img.shields.io/badge/Architecture-BYOK_Zero--Touch-7c7cff?style=flat-square)](#)
[![SaaS Tiers](https://img.shields.io/badge/SaaS_Tiers-Free_|_Pro_|_Studio-D4AF37?style=flat-square)](#)

</div>

---

## 🚀 How it Works (BYOK Model)
FlipStack uses a strict Zero-Touch Payout model. 
1. Developers create their own free Paystack accounts.
2. They input their Secret Key into the FlipStack dashboard.
3. When an end-user buys an app, the money goes **directly** into the developer's bank account. 
4. FlipStack never touches the money. We act as a SaaS orchestration layer, verifying the webhook to unlock "Pro" features via our API.

## ✨ Features
* **3D Carousel Storefront:** A smooth, mathematically driven 3D carousel built with Vanilla JS.
* **Installable PWA:** The store can be installed directly to an Android home screen with native app shortcuts.
* **Developer Dashboard:** Full SPA dashboard for managing apps, API keys, analytics, and revenue.
* **SaaS Tiers:** Free, Pro (R149/mo), and Studio (R399/mo) tiers with enforced API limits and app quotas.
* **Premium Splash Videos:** Developers can pay a one-time fee to unlock a 5-second splash video that plays when users tap their app.
* **A/B Splash Testing:** Studio-tier developers can upload two splash videos and track which variant converts better via the analytics dashboard.
* **Admin Moderation Portal:** A dedicated, secure PWA portal to review, approve, or reject pending splash videos before they go live.
* **Automated SEO:** Dynamic JSON-LD schema and Open Graph tags injected per app page.

## 🛠 Tech Stack
* **Frontend:** Vanilla HTML/CSS/JS (No React, no build tools. Served as a PWA).
* **Backend:** Node.js / Express.
* **Database:** MongoDB.
* **Payments:** Paystack API.
* **Server:** AlmaLinux VPS, Nginx, PM2.

## 🔒 Security
Developer Paystack Secret Keys are encrypted at rest using **AES-256-GCM** before being stored in MongoDB. 
SaaS tier upgrades are processed via isolated Paystack webhooks, ensuring complete financial separation between the platform and the developer's revenue.

---
<div align="center">
  <i>Built for indie developers who are tired of the 15-30% Google Play tax.</i><br>
  <b>© 2026 PAYBRIDGE (PTY) LTD.</b>
</div>
