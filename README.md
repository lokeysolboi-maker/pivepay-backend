# PIVEPAY - VTU & Payment Platform

A full-featured VTU (Virtual Top-Up) and payment processing platform built with **Node.js**, **Express**, **Firebase**, and **Flutterwave**.

## ✨ Features
- 🔐 Secure authentication with Firebase
- 🏦 Permanent virtual accounts via BVN KYC
- 💳 Wallet funding with Flutterwave (Card, Bank Transfer, USSD)
- 📱 VTU services: Airtime, Data, Cable TV, Electricity, Education, Talk More, Showmax
- 🤝 Multi-level referral program (earn ₦50 → ₦20 → ₦10 per level)
- 🛡️ Admin dashboard with full control over users, transactions, services, staff, and notifications
- 📨 Real‑time webhook handling for payment confirmations
- 🧾 Professional receipts with unique transaction IDs

## 🚀 Deployment

### 1. Required Environment Variables (Set on Render / Hosting)
| Variable | Description |
|----------|-------------|
| `FLW_PUBLIC_KEY` | Flutterwave public key |
| `FLW_SECRET_KEY` | Flutterwave secret key |
| `FLW_ENCRYPTION_KEY` | Flutterwave encryption key |
| `FLW_WEBHOOK_SECRET` | Secret to verify webhooks |
| `VTU_API_KEY` | Your VTU provider API key |
| `VTU_BASE_URL` | VTU provider base URL (e.g., `https://api.vtpass.com/api`) |
| `BASE_URL` | Your live app URL (e.g., `https://your-app.onrender.com`) |
| `FIREBASE_SERVICE_ACCOUNT` | Full JSON string of your Firebase Admin SDK key |

### 2. Folder Structure
📁 pivepay-backend/
├── 📄 server.js
├── 📄 package.json
├── 📄 .gitignore
├── 📄 README.md
├── 📄 Procfile (optional)
└── 📁 public/
├── 📄 index.html
└── 🖼️ logo.png
### 3. Deploy to Render
1. Push this repo to GitHub.
2. Connect your repo to Render (select "Web Service").
3. Set all environment variables in Render dashboard.
4. Render will automatically run `npm install` and `npm start`.

## 📡 API Endpoints (Key Ones)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/vtu-proxy` | POST | Purchase airtime/data/bills |
| `/api/initiate-payment` | POST | Create Flutterwave payment link |
| `/api/webhook/flutterwave` | POST | Webhook for payment confirmation |
| `/api/admin/stats` | GET | Admin dashboard stats |
| `/api/admin/transactions` | GET | List all transactions |

## 👨‍💻 Built With
- **Backend:** Node.js, Express, Firebase Admin SDK, Axios
- **Frontend:** Vanilla JS, Tailwind CSS, Firebase Auth SDK
- **Payments:** Flutterwave
- **VTU Provider:** VTPass (or any compatible provider)

## 📄 License
Private – All rights reserved.

---

**Made with ❤️ by the PIVEPAY Team**
