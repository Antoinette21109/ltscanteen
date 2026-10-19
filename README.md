"# Literacy Tree School Canteen

A web application for ordering food from the school canteen with integrated payment processing.

## Features

- Browse menu items
- Add items to cart
- Zynle-only payment integration
- Secure payment callbacks and order confirmation

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
