"# Literacy Tree School Canteen

A web application for ordering food from the school canteen with integrated payment processing.

## Features

- Browse menu items
- Add items to cart
- Mobile money payment integration (MTN/Airtel)
- Real-time payment processing with Stripe

## Prerequisites

- Node.js (version 14 or higher)
- npm

## Setup

1. Install Node.js from https://nodejs.org

2. Clone the repository

3. Install dependencies:
   ```bash
   npm install
   ```

4. Set up Stripe:
   - Create a Stripe account at https://stripe.com
   - Get your secret key and webhook secret
   - Update `.env` file with your Stripe keys

5. Run the server:
   ```bash
   npm start
   ```

6. Open `http://localhost:3000/menu.html` in your browser

## Payment Integration

The application uses Stripe for payment processing. Currently configured for card payments.

**Note:** For actual MTN/Airtel mobile money integration, you would need to use a payment provider that supports mobile money in your region, such as:
- Flutterwave
- Paystack
- M-Pesa API

The current implementation redirects to Stripe Checkout. To integrate mobile money, modify the server to use the appropriate API.

## Environment Variables

- `STRIPE_SECRET_KEY`: Your Stripe secret key
- `STRIPE_WEBHOOK_SECRET`: Your Stripe webhook secret
- `PORT`: Server port (default: 3000)" 
