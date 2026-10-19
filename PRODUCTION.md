# Production deployment guide

## 1. Project structure

```text
/workspaces/ltscanteen/
├── backend/
│   ├── package.json
│   └── src/
│       ├── app.js
│       ├── server.js
│       ├── config/
│       │   ├── db.js
│       │   └── env.js
│       ├── middleware/
│       │   └── auth.js
│       ├── routes/
│       │   ├── admin.js
│       │   ├── auth.js
│       │   └── orders.js
│       └── services/
│           └── zynleService.js
├── index.html
├── menu.html
├── contact.html
├── about.html
├── admin-dashboard.html
├── parent-dashboard.html
├── success.html
├── receipt.css
├── .env
├── README.md
├── package.json
├── canteen.db
└── mtn_complete_config.txt
```

## 2. Production configuration

Install dependencies:

```bash
cd /workspaces/ltscanteen/backend
npm install
```

Populate `.env` with production values:

```env
PORT=3000
NODE_ENV=production
JWT_SECRET=replace_me_with_secure_random_value
FRONTEND_URL=https://your-production-domain.com
ZYNLE_API_URL=https://your-zynle-api-domain
ZYNLE_API_KEY=your_zynle_api_key
ZYNLE_SECRET_KEY=your_zynle_secret_key
ZYNLE_MERCHANT_ID=your_zynle_merchant_id
ZYNLE_CALLBACK_URL=https://your-production-domain.com/api/payments/zynle-callback
PUBLIC_BASE_URL=https://your-production-domain.com
CURRENCY=ZMW
```

## 3. Run in production

```bash
cd /workspaces/ltscanteen/backend
npm start
```

## 4. Security checklist

- Do not commit `.env` to source control.
- Rotate `JWT_SECRET` and all Zynle secret values before production launch.
- Ensure the callback URL is publicly reachable over HTTPS.
- Validate the Zynle callback payload before marking an order as paid.
- Restrict admin access to authenticated administrators only.
- Use a process manager like PM2 or a managed hosting service for deployment.

## 5. Notes on Zynle

This project has been migrated to a single-provider Zynle flow. The `zynleService.js` layer is where the live provider request is sent, and the callback route is `/api/payments/zynle-callback`.

If the actual Zynle API contract differs from the standard request format, update the payload in the service and the callback validation in the orders route to match the provider contract exactly.
