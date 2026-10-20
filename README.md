"# Literacy Tree School Canteen

A web application for ordering food from the school canteen with integrated payment processing.

## Features

- Browse menu items
- Add items to cart
- Zynle-only payment integration
- Secure payment callbacks and order confirmation
- Parent and child profiles with Cloudinary photo uploads and child grades
- Scheduled meal orders and configurable email/browser break reminders
- Payment receipts emailed as PDF attachments, with admin resend controls

## Prerequisites

- Node.js (version 18 or higher)
- npm

## Setup

1. Install Node.js from https://nodejs.org
2. Clone the repository
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy `.env` and fill in your Zynle credentials:
   - `ZYNLE_API_URL`
   - `ZYNLE_API_KEY`
   - `ZYNLE_SECRET_KEY`
   - `ZYNLE_MERCHANT_ID`
   - `ZYNLE_CALLBACK_URL`
5. Run the server:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000/menu.html` in your browser

## Page URLs

The frontend supports extensionless URLs for all pages (for example, `/about`,
`/menu`, and `/contact`). Vercel uses `frontend/vercel.json` to rewrite these
paths to the existing HTML files and redirect legacy `.html` URLs to the clean URLs.

## Account roles

Sign in as a parent, staff member, or administrator using the account's assigned
role. Administrators can create staff accounts and manage account roles. Staff
can view and update orders. Staff must request menu access for each login
session; administrators approve that request and review each proposed menu
change before it is published. Menu changes include food details, image, price,
stock availability, and dated percentage promotions. Administrators can manage
the menu directly, approve access and menu change requests, and manage accounts.
Role and approval checks are enforced by the backend.

Food images are uploaded directly to Cloudinary using short-lived signatures
issued by the backend. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
and `CLOUDINARY_API_SECRET` in the backend environment to enable food and profile photo uploads.

Configure an SMTP account to email PDF receipts after successful payment and
send email break reminders:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
SMTP_FROM=Literacy Tree Canteen <canteen@example.com>
```

Browser push reminders require VAPID keys. Generate a key pair with
`npx web-push generate-vapid-keys`, then configure:

```env
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_SUBJECT=mailto:admin@literacytree.com
```

Administrators can add, edit, pause, or remove break, lunch, and other meal-time
schedules from **Admin Dashboard → Settings**. New databases start with a
10:30 AM morning break and 12:30 PM lunch, each with a 30-minute reminder.
`BREAK_TIME` and `BREAK_REMINDER_MINUTES` configure the initial morning-break
schedule; admins manage times after setup. `SCHOOL_TIME_ZONE` defaults to
`Africa/Lusaka`. Reminders run on weekdays. Parents opt in to email or browser
reminders from their dashboard.
Push notifications and installation require HTTPS outside localhost.
Only paid orders can receive email receipts; administrators can resend a receipt
from the admin order list. SMTP and VAPID credentials must be configured on the
backend before these delivery channels are available.

## Payment Integration

This project is configured for Zynle only. All other payment gateways have been removed from the codebase. The order creation flow and checkout UI only support the `zynle` method.

## Environment Variables

- `ZYNLE_API_URL`: Your Zynle API base URL
- `ZYNLE_API_KEY`: Your ZynLE API key
- `ZYNLE_SECRET_KEY`: Your Zynle secret key
- `ZYNLE_MERCHANT_ID`: Your merchant identifier
- `ZYNLE_CALLBACK_URL`: Callback URL for payment confirmation
- `PUBLIC_BASE_URL`: Public base URL for local fallback and callback generation
- `PORT`: Server port (default: 3000)
