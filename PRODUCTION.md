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
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
SMTP_HOST=your_smtp_host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
SMTP_FROM="Literacy Tree Canteen <canteen@example.com>"
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:admin@literacytree.com
SCHOOL_TIME_ZONE=Africa/Lusaka
CURRENCY=ZMW
```

Generate browser push keys with `npx web-push generate-vapid-keys`. SMTP is
required for order receipts and email reminders; VAPID keys are required for
browser push reminders. Profile image uploads use the Cloudinary credentials
listed above. Reminders are sent on weekdays in `SCHOOL_TIME_ZONE`. Admins set
break, lunch, and other reminder times from Admin Dashboard → Settings. New
databases are initialized with a 10:30 AM morning break and 12:30 PM lunch,
each with a 30-minute reminder. `BREAK_TIME` and `BREAK_REMINDER_MINUTES` can
override the initial morning-break schedule before the database is created.

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
- Configure Cloudinary environment variables to enable staff food-image uploads.
- Use a process manager like PM2 or a managed hosting service for deployment.

## 5. Notes on Zynle

This project has been migrated to a single-provider Zynle flow. The `zynleService.js` layer is where the live provider request is sent, and the callback route is `/api/payments/zynle-callback`.

If the actual Zynle API contract differs from the standard request format, update the payload in the service and the callback validation in the orders route to match the provider contract exactly.
