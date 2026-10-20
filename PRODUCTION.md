# Firebase and Cloudinary deployment

The production API is the root `server.js` entry point (`npm start`). Firebase
Authentication owns account credentials and Cloud Firestore stores application
data. Cloudinary stores uploaded image files; Firestore stores their HTTPS URLs.
SQLite is not used and no existing SQLite records are migrated.

## Firebase setup

1. Create a Firebase project, enable **Authentication → Email/Password**, add
   the production frontend domain to Authentication's authorized domains, and
   create a Firestore database.
2. Publish [firestore.rules](./firestore.rules) to that Firebase project. The
   client can read available menu items and only its own profile, children, and
   orders. Client writes are denied; role, menu, order, and payment changes go
   through the authenticated API using Firebase Admin.
3. Register a Firebase web app and replace the placeholder values in
   [frontend/api-config.js](./frontend/api-config.js).
4. Create a Firebase service account with Authentication and Firestore access.
   Configure its JSON as `FIREBASE_SERVICE_ACCOUNT_JSON` in the API host's
   secret environment; never commit the private key.
5. Set `FIREBASE_ADMIN_EMAILS` to a comma-separated list of trusted
   administrator email addresses. These are assigned the admin role when their
   profile is created or next authenticated by the API.
6. Deploy the frontend and root API. The API health endpoint should report
   `storage: "firebase-firestore"`.

## Required API environment

Start from [.env.example](./.env.example) and configure deployment secrets for
Firebase Admin, Cloudinary, and any enabled payment, email, or push services.
The browser Firebase settings are public app configuration; service-account,
Cloudinary API secret, payment, SMTP, and VAPID private keys are server secrets.

Set `FRONTEND_URL` to the deployed frontend origin and `PUBLIC_BASE_URL` to the
public API origin. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
`CLOUDINARY_API_SECRET` for image upload signatures. Menu and profile images
remain Cloudinary URLs in Firestore.

Zynle, SMTP, and push reminders remain optional integrations. Configure the
corresponding `ZYNLE_*`, `SMTP_*`, and `VAPID_*` variables when enabling them.
Before accepting production payments, confirm the Zynle callback verification
mechanism and configure it so an unauthenticated callback cannot mark an order
paid. A payment-provider callback contract cannot be validated without live
provider credentials.

## Data layout

- `users/{uid}`: profile, role, and reminder preferences
- `users/{uid}/children/{childId}`: children
- `users/{uid}/pushSubscriptions/{subscriptionId}`: push subscriptions
- `menuItems/{menuItemId}`: menu details and Cloudinary image URLs
- `orders/{orderId}` and `payments/{paymentId}`: orders and payment state
- `reminderSchedules`, `reminderDeliveries`, `menuAccessRequests`, and
  `menuChangeRequests`: operational data

The API seeds the default menu and reminder schedules only when those
collections are empty. Existing Firebase documents are preserved.
