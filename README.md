# PitStop Scheduler

PitStop Scheduler is a runnable auto shop booking and admin dashboard prototype. Customers can choose a Monday–Saturday drop-off hour, enter vehicle and contact details, receive simulated SMS/email confirmations, and cancel to reopen the slot. Shop staff can review the daily board, see carryover jobs, send the daily digest, complete work, and issue an invoice with a Stripe payment link placeholder.

## Run locally

```bash
npm start
```

Open http://localhost:8080.

The app uses Node's built-in HTTP server and stores demo bookings in `data.json` (ignored by Git). Set `PORT`, `ADMIN_PHONE`, and `STRIPE_PAYMENT_LINK_BASE` when connecting the UI to real services. The current notification and Stripe adapters are deliberately visible demo integrations: replace `notify()` with Twilio/SendGrid calls and the payment link construction with Stripe Checkout before production use.
