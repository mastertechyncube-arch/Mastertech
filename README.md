# MasterTech v2

MasterTech v2 keeps the existing single-page frontend and adds a Node.js backend with persistent server-side data, session-based admin authentication, product management, orders, messages, and site settings.

## Run locally

1. Install Node.js 18+.
2. Run:

```bash
MASTERTECH_ADMIN_PASSWORD='choose-a-strong-password' node server.js
```

3. Open `http://localhost:3000`.
4. Open **Admin** and use the password above.

If no password is supplied, the development fallback is `ChangeMe-2468`. Change it before deployment.

## Server data

Products, orders, messages, and settings are persisted in `data/mastertech-db.json`. For a larger production deployment, move this store to a managed database and use a production session store.

## Payments

There is intentionally **no online payment gateway**. Checkout creates a server-side order and then opens the customer's email app with the order request, matching the requested manual-payment workflow.

## Production checklist

- Set a strong `MASTERTECH_ADMIN_PASSWORD` using your hosting provider's secret/environment settings.
- Put the site behind HTTPS.
- Replace the JSON store with PostgreSQL/MySQL/SQLite as traffic grows.
- Add SMTP/email provider integration if automatic server-side email notifications are needed.
- Add backups and monitoring.


## Formspree
Customer-facing contact, project-request, checkout/order-request, and newsletter submissions are wired to the configured Formspree endpoint. No online payment is processed by Formspree.

Configured endpoint: `https://formspree.io/f/mbgjdewn`
