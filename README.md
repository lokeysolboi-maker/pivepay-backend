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