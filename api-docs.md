# multipay-api — Integration Guide

A self-hosted USDT payment gateway supporting **TRC-20 (Tron)** and **BEP-20 (BSC)** with **per-user wallet addresses**. Each end user gets a single deposit address per network that they can reuse across any number of payments — no need to surface a new address per order.

---

## How it works (the model in 30 seconds)

1. You create a **user** in our system once. We return two deposit addresses (one Tron, one BSC).
2. When that user owes you money, you create a **payment** with the user_id, network, and amount.
3. The user sends USDT to their saved address.
4. We watch the chain. When the **exact amount** lands and reaches confirmation threshold (15 blocks BSC / 19 blocks Tron), we fire a signed webhook to you.
5. You fulfill the order.

The same user keeps the same address forever. They can save it in their wallet's address book and use it for every payment.

---

## Base URL

```
https://your-deployment.onrender.com
```

All endpoints below are relative to this base.

---

## Authentication

Every `/v1/*` request must include your API key in a header:

```http
X-API-Key: your_api_key_here
```

Missing or invalid keys return `401 Unauthorized`. The `/health*` endpoints don't require a key.

Keep your API key secret — anyone with it can create payments and read user data on your account. If it leaks, contact us to rotate it.

---

## Rate limits

- **120 requests per minute** per IP.
- Exceeding it returns `429 Too Many Requests` with standard `RateLimit-*` response headers.

---

## Response format

All responses are JSON. Errors use a consistent shape:

```json
{
  "error": "machine_readable_code",
  "message": "Human-readable description"
}
```

Common HTTP status codes:

| Status | Meaning |
|---|---|
| `200` | OK — resource fetched or action accepted |
| `201` | Created — new resource |
| `400` | Bad request — see `error` field |
| `401` | Missing or invalid `X-API-Key` |
| `404` | Resource not found |
| `409` | Conflict — see `error` field |
| `429` | Rate limited |
| `500` | Internal error — safe to retry with backoff |

---

## Payment status values

| Status | Meaning | Safe to fulfill? |
|---|---|---|
| `pending` | Awaiting payment from the user. | No |
| `received` | Funds arrived on-chain but not enough confirmations yet. | **No** — could still drop in a re-org |
| `confirmed` ✅ | Fully settled. | **Yes** |
| `expired` | Payment window passed without sufficient funds. | Cancel the order |

Always wait for `confirmed` before delivering goods or services.

---

# Endpoints

## Health

### `GET /health/live`

Liveness probe — no auth, no DB. Used by load balancers.

**Response 200:**
```json
{ "status": "ok", "uptime_seconds": 3600 }
```

### `GET /health/ready`

Readiness probe — verifies the database is reachable.

**Response 200:**
```json
{ "status": "ok", "mongo": true }
```

**Response 503:** Service not ready (DB down).

### `GET /health`

Detailed counters for monitoring. Requires API key.

**Response 200:**
```json
{
  "status": "ok",
  "uptime_seconds": 3600,
  "users": 1234,
  "payments": { "pending": 5, "terminal": 9201 },
  "webhooks_queued": 0,
  "deposits": 9180,
  "time": "2026-05-16T10:00:00.000Z"
}
```

---

## Users

A **user** is your end customer. You assign the `user_id` — it can be anything stable: an email, a UUID, an account number. We use it to deterministically generate the same pair of addresses for that user, forever.

### `POST /v1/users`

Create a user, or fetch an existing one. **Idempotent** — safe to call repeatedly with the same `user_id`.

**Request:**
```http
POST /v1/users
X-API-Key: your_api_key
Content-Type: application/json

{ "user_id": "customer_42" }
```

**Response 201** (new user) or **200** (existing):
```json
{
  "user_id": "customer_42",
  "tron_address": "TXyzABC123...",
  "bsc_address": "0xAbC123...",
  "created_at": "2026-05-16T10:00:00.000Z"
}
```

**Errors:**

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_user_id` | Missing or non-string |

**curl example:**
```bash
curl -X POST https://your-host/v1/users \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"customer_42"}'
```

---

### `GET /v1/users/:user_id`

Fetch a user's addresses.

**Response 200:**
```json
{
  "user_id": "customer_42",
  "tron_address": "TXyzABC123...",
  "bsc_address": "0xAbC123...",
  "created_at": "2026-05-16T10:00:00.000Z"
}
```

**Errors:**

| Status | `error` |
|---|---|
| 404 | `not_found` |

---

## Payments

A **payment** is a single expected deposit from a user. It has an expected amount, a network, and a 30-minute window by default.

### `POST /v1/payments`

Create a payment for an existing user.

**Request:**
```http
POST /v1/payments
X-API-Key: your_api_key
Content-Type: application/json

{
  "user_id": "customer_42",
  "network": "tron",
  "amount": "25.00",
  "order_id": "order_abc_123",
  "webhook_url": "https://your-app.com/webhooks/usdt",
  "expires_in_minutes": 30
}
```

**Fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `user_id` | string | yes | User must already exist (`POST /v1/users` first) |
| `network` | string | yes | `"tron"` or `"bsc"` |
| `amount` | string | yes | Positive number as string (avoids float precision issues). Normalized to up to 6 decimals; trailing zeros stripped |
| `order_id` | string | yes | Your internal order reference. Stored alongside the payment |
| `webhook_url` | string | no | https URL we'll POST to on terminal status |
| `expires_in_minutes` | integer | no | Default 30. After expiry the payment terminalizes as `expired` |

**Response 201:**
```json
{
  "payment_id": "pay_53d10ad53be04ef3ac306a88afb4e364",
  "user_id": "customer_42",
  "order_id": "order_abc_123",
  "network": "tron",
  "network_label": "TRC20 (Tron)",
  "amount": "25",
  "address": "TXyzABC123...",
  "status": "pending",
  "expires_at": "2026-05-16T10:30:00.000Z"
}
```

**Errors:**

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_user_id` | Missing |
| 400 | `invalid_network` | Not `tron` or `bsc` |
| 400 | `invalid_amount` | Missing or non-positive |
| 400 | `invalid_order_id` | Missing |
| 400 | `invalid_webhook_url` | Not http(s) |
| 404 | `user_not_found` | Create the user first |
| 409 | `duplicate_pending_amount` | This user already has a pending payment for this exact amount on this network. Response includes `existing_payment_id` so you can reuse or cancel |

**Important — amount normalization.** We normalize amounts to up to 6 decimal places and strip trailing zeros for matching. `"25.00"`, `"25"`, and `"25.000000"` are all stored as `"25"`. The user must send exactly that amount — `"25.01"` will not match a `"25"` payment. Show the normalized `amount` from the response to your user, not the value you sent in the request.

**Important — network identification.** The `network` field determines which chain the user must send on. Sending USDT-BEP20 to a Tron address (or vice versa) loses the funds permanently. Always show the user the `network_label` clearly alongside the address — for example: *"Send USDT on the **TRC20 (Tron)** network to this address"*.

**curl example:**
```bash
curl -X POST https://your-host/v1/payments \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "customer_42",
    "network": "tron",
    "amount": "25.00",
    "order_id": "order_abc_123",
    "webhook_url": "https://your-app.com/webhooks/usdt"
  }'
```

---

### `GET /v1/payments/:payment_id`

Look up the current state of a payment.

**Response 200:**
```json
{
  "payment_id": "pay_53d10ad53be04ef3ac306a88afb4e364",
  "user_id": "customer_42",
  "order_id": "order_abc_123",
  "network": "tron",
  "network_label": "TRC20 (Tron)",
  "amount": "25",
  "address": "TXyzABC123...",
  "status": "confirmed",
  "confirmations": 19,
  "tx_hash": "0xabc...",
  "expires_at": "2026-05-16T10:30:00.000Z",
  "created_at": "2026-05-16T10:00:00.000Z"
}
```

**Errors:**

| Status | `error` |
|---|---|
| 404 | `not_found` |

Polling this endpoint as a fallback to webhooks is fine — keep it to once every 10–30 seconds for any given payment, and stop polling once you see `confirmed` or `expired`.

---

### `GET /v1/payments`

List recent payments. Useful for admin dashboards and reconciliation.

**Query parameters:**

| Param | Type | Notes |
|---|---|---|
| `user_id` | string | Filter to one user |
| `status` | string | One of `pending`, `terminal` |
| `limit` | integer | Default 50, max 200 |

**Response 200:**
```json
{
  "payments": [
    { "payment_id": "...", "status": "confirmed", "..." },
    { "payment_id": "...", "status": "pending", "..." }
  ]
}
```

Newest first.

---

### `POST /v1/payments/:payment_id/replay-webhook`

Re-queue a webhook for a payment that's already terminalized. Use this if your endpoint was down during the original delivery window and our 6 retries exhausted.

**Request:**
```http
POST /v1/payments/pay_.../replay-webhook
X-API-Key: your_api_key
```

**Response 200:**
```json
{ "status": "queued" }
```

The webhook fires within ~5 seconds.

**Errors:**

| Status | `error` | Cause |
|---|---|---|
| 404 | `not_found` | Unknown payment_id |
| 409 | `not_terminal` | Payment is still `pending` |
| 400 | `no_webhook` | Payment was created without a `webhook_url` |

---

# Webhooks

When a payment reaches a **terminal state** (`confirmed` or `expired`) and was created with a `webhook_url`, we POST to that URL.

## Delivery guarantees

- **At-least-once delivery.** Your endpoint must be idempotent on `payment_id`.
- **6 attempts** with exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m.
- A delivery is considered successful when your endpoint returns **2xx within 10 seconds**.
- Any non-2xx or timeout triggers a retry until attempts exhaust, then the webhook is marked failed (use the replay endpoint to recover).

## Payload

```json
{
  "event": "payment.confirmed",
  "payment_id": "pay_53d10ad53be04ef3ac306a88afb4e364",
  "user_id": "customer_42",
  "order_id": "order_abc_123",
  "network": "tron",
  "amount": "25",
  "address": "TXyzABC123...",
  "tx_hash": "0xabc...",
  "status": "confirmed",
  "confirmations": 19,
  "timestamp": "2026-05-16T10:15:00.000Z"
}
```

**Possible event values:**

| `event` | When |
|---|---|
| `payment.confirmed` | Funds received and confirmed on-chain |
| `payment.expired` | Window passed without matching deposit |

## Signature verification (required)

Every webhook includes an `X-Signature` header — the HMAC-SHA256 of the **raw request body** using your `WEBHOOK_SECRET`, hex-encoded. **You must verify it before trusting the payload.**

Without verification, anyone who guesses your endpoint URL could forge a "confirmed" webhook and steal goods.

### Verifying in Node.js

```javascript
const crypto = require('crypto');

app.post('/webhooks/usdt', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.header('X-Signature');
  const expected = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(req.body)            // raw Buffer, NOT the parsed object
    .digest('hex');

  if (!signature || !crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  )) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(req.body.toString('utf8'));
  // Idempotency: check if you've already processed payload.payment_id
  // Then handle payload.event
  res.sendStatus(200);
});
```

### Verifying in Python

```python
import hmac
import hashlib
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = b"your_webhook_secret"

@app.post("/webhooks/usdt")
def handle_webhook():
    signature = request.headers.get("X-Signature", "")
    expected = hmac.new(
        WEBHOOK_SECRET,
        request.data,           # raw bytes, NOT request.json
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(signature, expected):
        abort(401)

    payload = request.json
    # Check idempotency on payload["payment_id"], then handle the event
    return "", 200
```

### Verifying in PHP

```php
<?php
$secret = getenv('WEBHOOK_SECRET');
$body = file_get_contents('php://input');           // raw, before json_decode
$signature = $_SERVER['HTTP_X_SIGNATURE'] ?? '';
$expected = hash_hmac('sha256', $body, $secret);

if (!hash_equals($expected, $signature)) {
    http_response_code(401);
    exit('Invalid signature');
}

$payload = json_decode($body, true);
// Idempotency on $payload['payment_id'], then handle $payload['event']
http_response_code(200);
```

### Verifying in Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
    "os"
)

func handleWebhook(w http.ResponseWriter, r *http.Request) {
    secret := []byte(os.Getenv("WEBHOOK_SECRET"))
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "bad body", http.StatusBadRequest)
        return
    }
    sig := r.Header.Get("X-Signature")
    mac := hmac.New(sha256.New, secret)
    mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))

    if !hmac.Equal([]byte(sig), []byte(expected)) {
        http.Error(w, "bad signature", http.StatusUnauthorized)
        return
    }

    // Process body; respond 200
    w.WriteHeader(http.StatusOK)
}
```

**Two critical points for any language:**

1. Sign the **raw request body bytes**, not a re-serialized JSON object. Re-serializing changes whitespace and key order, which breaks the signature.
2. Use a **timing-safe** comparison (`hmac.compare_digest`, `crypto.timingSafeEqual`, `hash_equals`, `hmac.Equal`). Don't use `==`.

---

# Integration flow — end to end

Here's the complete flow for an e-commerce checkout:

### One-time setup

1. We give you an API key and webhook secret. Store both as environment variables.
2. Decide which networks you'll offer (most apps offer both BEP-20 and TRC-20).

### Per user — first time only

When a user first registers (or first reaches checkout):

```bash
POST /v1/users { "user_id": "your_user_id" }
```

Store the returned `tron_address` and `bsc_address` against that user in your DB. **You don't need to call this again for the same user** — but it's safe (idempotent) if you do.

### Per payment

When the user clicks "pay with crypto":

1. **Ask them which network they want to pay on** (TRC-20 or BEP-20).
2. **Create the payment:**
   ```json
   POST /v1/payments
   {
     "user_id": "your_user_id",
     "network": "tron",
     "amount": "25.00",
     "order_id": "your_order_ref",
     "webhook_url": "https://yourapp.com/webhooks/usdt"
   }
   ```
3. **Show the user:**
   - The exact amount (use the `amount` field from the response, after normalization)
   - The network — clearly label it `TRC20 (Tron)` or `BEP20 (BSC)`
   - The deposit address (and a QR code of it)
   - A countdown to `expires_at`
4. **Wait for the webhook.** When `event: "payment.confirmed"` arrives:
   - Verify the signature
   - Check idempotency on `payment_id`
   - Mark the order paid; fulfill
5. **Backup polling.** If you haven't received a webhook within ~10 minutes, hit `GET /v1/payments/:id` to check status. Stop polling once you see `confirmed` or `expired`.

### Idempotency on your side

Save webhook deliveries by `payment_id`. If you receive the same `payment_id` twice (because our retry was triggered before your 200 reached us), treat the second as a no-op. This is a hard requirement — we will sometimes redeliver.

---

# Common questions

**Can a user have multiple pending payments at once?**
Yes — but not two pending payments for the *same network and same exact amount*. If you try, you get `409 duplicate_pending_amount` and the response tells you which existing payment you're conflicting with. This is the matching logic: a deposit of $25 to user X's TRX address can only mean one specific $25 pending payment.

**What if the user sends the wrong amount?**
We only match an exact amount. If they send less, the payment stays pending and expires. If they send more, same thing. Funds aren't lost — they sit on the user's deposit address and the next sweep moves them to the merchant's main wallet, but the *payment* won't auto-confirm. Handle these cases manually.

**What if the user sends after the payment expires?**
The payment is marked `expired` and the webhook fires with `event: "payment.expired"`. Funds still arrive on the address and are swept normally, but no specific payment is matched. Reconcile out-of-band — or restart the order flow and create a new payment for the same amount, which will then match the deposit retroactively if you do it before the user has paid again.

**Can I cancel a payment?**
There's no explicit cancel endpoint, but you can just stop showing the user the address. The payment expires after the window. Lower `expires_in_minutes` on creation if you need a faster turnover.

**How long do confirmations take?**
- BSC: ~15 blocks × 3s = **~45 seconds**
- Tron: ~19 blocks × 3s = **~1 minute**

So typically a payment goes from `received` to `confirmed` within a minute of arriving.

**Can I get a real-time `received` event?**
Currently webhooks fire only on terminal state (`confirmed` / `expired`). If you need a `received` ping, poll `GET /v1/payments/:id` — the `status` will flip to `received` as soon as we see the on-chain deposit, before confirmations land.

**What's the testnet?**
Not supported in this gateway — only mainnet BSC and Tron. For end-to-end testing, do a $1 real-money smoke test.

---

# Quick reference

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/health/live` | Liveness | none |
| GET | `/health/ready` | Readiness | none |
| GET | `/health` | Detailed counters | API key |
| POST | `/v1/users` | Create / fetch user | API key |
| GET | `/v1/users/:id` | Get user | API key |
| POST | `/v1/payments` | Create payment | API key |
| GET | `/v1/payments/:id` | Get payment | API key |
| GET | `/v1/payments` | List payments | API key |
| POST | `/v1/payments/:id/replay-webhook` | Re-queue webhook | API key |

**Headers on every `/v1/*` request:** `X-API-Key: ...`
**Headers on every webhook delivery:** `X-Signature: <hex hmac-sha256 of body>`

---

*Generated for multipay-api v2.1.0. Questions? Contact your integrator.*
