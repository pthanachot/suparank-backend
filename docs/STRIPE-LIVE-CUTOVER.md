# Stripe test → live cutover (Phase 13)

Goal: charge real customers. The end-to-end chain that must work is
**checkout → webhook → subscription record → monthly credit grant → tier entitlements**,
and a charge must be refundable.

Most of this is Stripe-account + prod-env work (your side). The repo now ships tooling
to make it safe and repeatable:

| Tool | What it does |
|---|---|
| `src/config/stripeCatalog.js` | SSOT price manifest, **derived** from `configTiers.js` + `creditPacks.js` (amounts can't drift). |
| `scripts/createStripePrices.js` | Idempotently creates the products/prices in the current key's mode; prints the env block. |
| `scripts/verifyStripePrices.js` | Read-only preflight: every price env var resolves to a real, correctly-priced, mode-matched Stripe price. |
| `src/config/validateStripeConfig.js` | Boot check: a live key with missing/stale price vars is **fatal in production** (no more silent drops). |

All amounts come from the tier configs, so they always match what the app entitles:
Standard $29 / $276·yr · Pro $99 / $948·yr · Agency $299 / $2,868·yr · extra seat $10/mo ·
credit packs $25 / $60 / $180.

---

## 0. Prerequisites — your side (Stripe Dashboard)

1. **Activate the Stripe account** for live payments: business details, bank account,
   identity/verification. Until this is done, live charges are rejected.
2. Grab the **live secret key** (`sk_live_…`) from Developers → API keys (live mode toggle ON).
   A **restricted live key** (`rk_live_…`) also works — the mode detection and boot validation key
   off the `_live_`/`_test_` segment, not the `sk_` prefix. There is **no publishable key to
   switch** — checkout is redirect-only (the backend creates a Checkout Session and returns its
   URL), so the frontend needs no Stripe key or change.

## 1. Create the live products & prices

From `backend/` with the **live** key exported (do a dry run first):

```bash
STRIPE_SECRET_KEY=sk_live_xxx node scripts/createStripePrices.js --dry-run   # preview
STRIPE_SECRET_KEY=sk_live_xxx node scripts/createStripePrices.js             # create + print env block
```

It creates (or reuses — it's idempotent via `lookup_key`) 11 prices across 5 products and prints:

```
STRIPE_STANDARD_MONTHLY_PRICE_ID=price_...
STRIPE_STANDARD_YEARLY_PRICE_ID=price_...
STRIPE_PRO_MONTHLY_PRICE_ID=price_...
STRIPE_PRO_YEARLY_PRICE_ID=price_...
STRIPE_AGENCY_MONTHLY_PRICE_ID=price_...
STRIPE_AGENCY_YEARLY_PRICE_ID=price_...
STRIPE_PRO_EXTRA_SEAT_MONTHLY_PRICE_ID=price_...
STRIPE_AGENCY_EXTRA_SEAT_MONTHLY_PRICE_ID=price_...
STRIPE_CREDIT_PACK_SMALL_PRICE_ID=price_...
STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID=price_...
STRIPE_CREDIT_PACK_LARGE_PRICE_ID=price_...
```

## 2. Configure the live webhook endpoints (Stripe Dashboard → Developers → Webhooks, live mode)

Add **two** endpoints (both must exist; each has its own signing secret):

1. **Platform:** `https://<api-host>/api/billing/webhooks`
   Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`.
   → copy its signing secret to **`STRIPE_WEBHOOK_SECRET`**.
2. **Connect** (SaaS mode; keep even if dark): `https://<api-host>/api/billing/connect-webhooks`
   → copy its signing secret to **`STRIPE_CONNECT_WEBHOOK_SECRET`**.

## 3. Set the production environment

On the server (Railway/host env), set the 11 price vars from step 1, plus:

```
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx            # platform endpoint (step 2.1)
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxx    # connect endpoint (step 2.2)
```

`.env.example` lists every Stripe var. Deploy. On boot, `validateStripeConfig` runs:
a live key with any missing price var, a stale test-mode price id, or a missing webhook
secret **aborts the boot in production** with a clear message — so a half cutover can't go live silently.

## 4. Preflight

Point the tool at the live env and confirm everything is green:

```bash
node scripts/verifyStripePrices.js
```

Exit 0 only when config is clean AND every price exists, is active, matches the manifest
amount/currency/interval, and its `livemode` matches the key. Use it as a deploy gate.

## 5. Live smoke test (the acceptance test)

With a **real** card (or your own), on the live site:

1. Check out a plan (e.g. Standard monthly) → completes and redirects back.
2. Confirm the chain landed: `Subscription` row created (`status: active`, correct `planId`),
   tier entitlements unlocked, and the monthly credit pool granted
   (`creditService.grantMonthlyCreditsIfDue`).
3. Buy a credit pack → GENERAL credits added.
4. **Refund** the charge in the Dashboard and cancel the subscription →
   `customer.subscription.deleted` zeroes seats, expires subscription credits, resets usage.

If checkout succeeds but no subscription appears, the webhook didn't land or a price id is
unmapped — check the webhook endpoint's delivery log and re-run step 4's `verifyStripePrices`.

---

## Known gaps & notes (decide before/with the cutover)

- **Legacy price literals.** `stripePrices.js` L14–16 hardcode 3 *archived test-mode* price ids
  (old $59 / $564 / $2,988) with no env override, kept so old test subs still resolve. On a fresh
  live account there are no live subs on them, so they're inert — but they can't map any live sub.
  If any legacy subscription must survive a migration, add live ids for them (code edit).
- **Yearly extra-seat is unwired.** `configTiers` defines a single flat `extraSeatPrice`; the
  `*_EXTRA_SEAT_YEARLY_PRICE_ID` vars are `null`, so a *yearly* subscriber can't buy extra seats.
  The manifest intentionally omits them. Wire a yearly-seat price + env var if that's in scope.
- **Credit packs / extra seats dark-ship.** Their env vars start unset → checkout returns 503 until
  you set the live ids from step 1.
- **API version — now pinned everywhere.** All `new Stripe()` instances (billing / webhook / user /
  admin controllers, the Connect `stripeService`, and the cutover scripts) share the pinned version
  from `src/config/stripeApiVersion.js` (`2026-02-25.clover`), so a live account's default API
  version can't silently change response shapes. A live smoke test (step 5) is still the final
  confirmation after any Stripe SDK bump.

## Rollback

Revert `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` to their
test values (retrieve from the Stripe Dashboard in test mode) and UNSET the 11 price vars —
the test-mode price ids are the hardcoded fallbacks in `src/config/stripePrices.js`, used
whenever the env vars are unset. Redeploy. Test-mode subscriptions are unaffected by
live-mode objects.
