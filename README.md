# Cochin Express (Tally Connect)

Serverless Express API for Vercel — order processing, batch updates, and punch-in emails for Cochin Traders.

## Overview

This repository contains a small Express-based API adapted for serverless deployment (Vercel). It provides two main endpoints:

- POST `/api/orders/:companyName/:shopName` — process an order, decrement batch quantities in MongoDB, and send an order confirmation email.
- POST `/api/punch-in` — record a punch-in and send an email notification.

The API is implemented in `api/index.js` and exported with `serverless-http` for platform compatibility.

## Prerequisites

- Node.js 16+ (or the runtime used by Vercel)
- A MongoDB connection (Atlas or self-hosted)
- SMTP credentials for sending emails

## Environment Variables

Set these in your environment (or in Vercel project settings):

- `MONGODB_URL` or `MONGO_URL` — MongoDB connection string
- `MONGODB_DB` — database name (default: `TallyDB`)
- `API_Key` — required API key to be sent via `x-api-key` header
- `MAIL_FROM_EMAIL` — SMTP username / from address
- `MAIL_FROM_PASS` — SMTP password
- `MAIL_FROM_NAME` — sender display name
- `MAIL_TO_EMAIL` — recipient address for outgoing emails
- `MAIL_TO_NAME` — recipient display name

Note: The code falls back to some default (development) values if env vars are not set; do not use those defaults in production.

## Install & Run Locally

1. Install dependencies:

```bash
npm install
```

2. Run locally (the file includes a local server entrypoint):

```bash
node api/index.js
```

Server will listen on `http://localhost:3000` by default.

## Deployment

This project is configured for Vercel. The `vercel.json` includes a Node build for `api/index.js` and routes `/api/*` to that file.

To deploy:

```bash
vercel deploy --prod
```

(or use the Vercel dashboard and set environment variables in the project settings)

## API Usage

All requests must include the `x-api-key` header with the value of `API_Key`.

1) Place an order

- Endpoint: `POST /api/orders/:companyName/:shopName`
- Body: JSON array of items. Each item must have `stockItem` and `pieces` (object mapping batch size to quantity).

Example curl:

```bash
curl -X POST "http://localhost:3000/api/orders/MyCompany/MyShop" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '[{"stockItem":"ItemA","pieces":{"10":2,"20":1}}]'
```

Successful response contains `success: true` and updated batch information.

2) Punch-in

- Endpoint: `POST /api/punch-in`
- Body: JSON with fields: `employeeName`, `employeePhone`, `companyName`, `shopName`, `amount`, `location` (optional), `time`, `date`.

Example curl:

```bash
curl -X POST "http://localhost:3000/api/punch-in" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"employeeName":"Raj","employeePhone":"9999999999","companyName":"MyCompany","shopName":"MyShop","amount":500,"time":"09:15","date":"2026-02-09"}'
```

Response: JSON with `success: true` and the submitted data, or `success: false` with an error message.

## Notes & Security

- Protect the `API_Key` and SMTP credentials. Use Vercel environment variables or a secrets manager in production.
- The app expects MongoDB documents in the `stockBatches` collection with a structure containing `batches` (array with `size` and `quantity`) and `totalQuantity`.
- Email sending is attempted but failures are ignored for order processing; punch-in requires a configured mail transporter.

## Files to Inspect

- `api/index.js` — main Express app and route implementations
- `vercel.json` — Vercel build & route configuration
- `package.json` — project metadata and dependencies

## Want me to?

- Add example MongoDB seed data for `stockBatches`.
- Add automated tests for the endpoints.

If you'd like either, tell me which and I'll add it.

---

Generated README for this project.
