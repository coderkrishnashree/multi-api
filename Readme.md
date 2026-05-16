# multipay-api

Self-hosted USDT payment gateway. Per-user HD-derived addresses on BSC (BEP-20) and Tron (TRC-20). Watches deposits via JSON-RPC, matches them to invoices, signs and delivers webhooks with retry, and includes a cron-scheduled sweep that consolidates balances to your cold wallets.

## Quick start (local)

```bash
git clone <repo>
cd multipay-api
npm install
cp .env.example .env
# Edit .env. At minimum set:
#   DB_URL, API_KEYS, WEBHOOK_SECRET, MASTER_MNEMONIC,
#   BSC_RPC_URL, TRON_HTTP_URL
npm run generate-mnemonic   # if you don't have one yet — save the output
npm run dev                 # nodemon + pino-pretty
```

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/live` | Liveness probe (no DB) |
| `GET` | `/health/ready` | Readiness probe (pings Mongo) |
| `GET` | `/health` | Detailed counters |
| `POST` | `/v1/users` | Create or fetch a user (returns both addresses) |
| `GET` | `/v1/users/:id` | Get a user |
| `POST` | `/v1/payments` | Create a payment for a user |
| `GET` | `/v1/payments/:id` | Status |
| `GET` | `/v1/payments?user_id=&status=&limit=` | List |
| `POST` | `/v1/payments/:id/replay-webhook` | Manual webhook redelivery |

All `/v1/*` require `X-API-Key`.

Webhook payloads are HMAC-SHA256 signed; signature is sent in `X-Signature` over the raw JSON body using `WEBHOOK_SECRET`.

## Deploy to Render

1. Push to GitHub.
2. Render dashboard → New → Blueprint → connect repo → it reads `render.yaml`.
3. Fill in the `sync: false` env vars under each service's Environment tab (DB_URL, MASTER_MNEMONIC, API_KEYS, etc.).
4. The web service deploys automatically. The cron job runs hourly.

Render's healthcheck is set to `/health/live`. If `/health/ready` fails, traffic still routes (it's informational); set up UptimeRobot on it for a real alert.

## Production checklist

- [ ] `MASTER_MNEMONIC` generated fresh, stored in 1Password + .env, never committed
- [ ] `API_KEYS` and `WEBHOOK_SECRET` generated fresh (any value from prior chats rotated)
- [ ] Atlas IP allowlist restricted (not 0.0.0.0/0)
- [ ] Atlas backups enabled (or mongodump cron)
- [ ] `BSC_MAIN_WALLET` and `TRON_MAIN_WALLET` set to client's cold wallets
- [ ] Gas wallets (`BSC_GAS_WALLET_PK`, `TRON_GAS_WALLET_PK`) funded — small BNB + TRX
- [ ] UptimeRobot monitoring `/health/ready`
- [ ] Sweep dry-run successful (`npm run sweep:dry`) before enabling cron
- [ ] First $1 end-to-end test on both networks
- [ ] Client given API key over secure channel (1Password share, not email)

## Operations runbook

**Rotate an API key.** Add a new key to `API_KEYS` env var (comma-separated), redeploy, hand to client. After confirmation, remove the old key and redeploy.

**Replay a failed webhook.**
```bash
curl -X POST https://your-host/v1/payments/PAYMENT_ID/replay-webhook \
  -H "X-API-Key: $API_KEY"
```

**Inspect a payment.**
```javascript
db.payments.findOne({ payment_id: "pay_..." })
```

**Top up gas.** Send a small amount of BNB to the address derived from `BSC_GAS_WALLET_PK`, and TRX to the Tron gas wallet. Check `sweep.js` output for low-gas warnings.

**Force a sweep now.** Trigger the cron from the Render dashboard, or `npm run sweep` from a workstation with `.env` loaded.

**Verify backups restore.** Quarterly: restore Atlas snapshot to a scratch cluster, point a staging instance at it, check counts roughly match prod.

## Security notes

- The master mnemonic controls every user's funds. Treat it like a vault key.
- The wrapper never exposes private keys; derivation happens in-process on demand.
- Webhook receivers MUST verify the `X-Signature` header before trusting payloads.
- HTTPS only — Render gives you this automatically.