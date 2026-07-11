# Tenant Restore Runbook (Phase 18D)

How to bring a **suspended** agency tenant back to active. Pairs with the
offboarding state machine (`services/lifecycleService.js`), data export
(Phase 18B), and data deletion (Phase 18C). Dark behind the `saasMode` flag —
inert until SaaS mode launches.

## Lifecycle recap

```
active ──entitlement lost──▶ winding_down ──30d grace──▶ suspending ──▶ suspended ──90d retention──▶ (purged)
  ▲             recover │(re-subscribe)                                     │ restore (re-subscribe / operator)
  └──────────────────────────────────────────────────────────────────────┘
```

- **winding_down → active** is `recover()` (automatic on re-subscribe). Nothing was
  torn down yet, so it's a clean flip.
- **suspended → active** is `restoreSuspendedOrg()` — this runbook. Teardown already
  ran, so restore has to reverse it.
- After **purge** (retention elapsed, Phase 18C) client workspaces are **gone**.
  Restore can reactivate the org shell but not the client data — that needs an
  export-archive import (not yet built).

## When to use

| Situation | Action |
|-----------|--------|
| Agency re-subscribed after suspension | Automatic — `reconcile()` calls restore on the billing webhook. Verify, don't act. |
| Support-initiated restore (agency contacted us) | Confirm they've re-subscribed, then run `node src/scripts/restoreOrg.js <orgId>`. |
| Org still `winding_down` (grace not elapsed) | Not this runbook — a re-subscribe auto-`recover()`s it. |
| Org already `purged` | Restore reactivates the shell only; client data is unrecoverable without an export import. |

> **Precondition — entitlement first.** Restore flips the org to `active`. If the
> agency is **not** entitled again (no active platform subscription), the next
> billing reconcile will wind it right back down, and branding won't apply
> (branding is entitlement-gated). Always confirm re-subscription before a manual
> restore.

## What restore does (automatically)

| suspend() did | restore does |
|---------------|--------------|
| Deactivated custom domains (status `suspended`, Cloudflare hostname deleted) | **Resets to `pending_dns`** and attempts an immediate re-verify. DNS is usually unchanged during suspension, so the Cloudflare hostname is re-created and the host goes `active` again. A failed re-verify leaves it at `pending_dns` to re-verify manually. (If suspend's CF delete had failed and left a hostname, restore deletes it first to avoid orphaning it.) |
| Reverted branding (cache cleared; entitlement gate hid it) | **Clears the brand cache** — branding re-applies automatically now the org is active **and** entitled. |
| Locked client workspaces (`clientLocked=true`) | **Left locked on purpose.** The client subs were cancelled, so unlocking would grant unbilled access. Each client's workspace unlocks when the client re-subscribes through it (see below). |
| Cancelled client subscriptions on Stripe | **Cannot be reversed.** Stripe cancellations are final. Restore **collects** the subs this suspension cancelled into a report for manual outreach. |

Restore claims an intermediate `restoring` status before doing any of this. Purge
claims a `purging` status before it deletes. The two claims exclude each other's
transient state, so a restore and a retention purge can never run on the same org
at once — no half-purged restore, no purge of a just-restored org. Restore is
idempotent; a crashed `restoring` org is re-driven by an hourly sweep (or by
re-running the script). Two live restores can't overlap either: an in-flight
`restoring` claim acts as a 1-hour lease that only a crashed (stale) restore
relinquishes.

Two hourly sweeps (`:20`) keep the machine self-healing:

- **`resumeStuckRestores`** finishes restores stranded mid-flight by a crash. It is
  deliberately **not** flag-gated — darking `saasMode` never strands a `restoring` org.
- **`restoreEntitledSuspended`** restores any suspended org that is entitled again.
  This closes the lost-wakeup: a re-subscribe that lands *during* teardown or purge
  is silently dropped by `reconcile` (no transient-state branch), and the next
  billing webhook may be a month away — the sweep picks it up within the hour.

Kill-switch semantics: the auto-purge requires **both** `dataErasure` *and*
`saasMode` — darking either pauses destruction, and the purge sweep rolls any org
stranded in `purging` back to `suspended` (restorable). A merely `past_due`
platform subscription (dunning) never triggers wind-down — offboarding starts only
once the subscription actually cancels.

## What you must do manually

1. **Client re-subscription (the big one).** Every client whose subscription was
   cancelled must re-subscribe. The restore result lists them under
   `clientSubsNeedingResubscribe` (`clientEmail` + `workspaceId`).
   > **Send each client the checkout link for their EXISTING workspace** (the
   > normal client-checkout carrying that `workspaceId`). That binds the new
   > subscription to the existing workspace and unlocks it — content intact. Do
   > **not** have them start a fresh/self-serve checkout with no workspace: that
   > provisions a **second, empty** workspace and strands their content.
   Until a client re-subscribes, their workspace stays locked.
2. **DNS re-verification (only if auto re-verify failed).** If a domain is left at
   `pending_dns` / `failed`, have the agency confirm the CNAME/TXT records (see the
   domain settings page) and re-verify. Records are usually still in place, so this
   is rare.
3. **Confirm branding renders** on the agency's custom host once SSL re-provisions
   (Cloudflare hostname re-creation can take a few minutes).

## Running a manual restore

```bash
node src/scripts/restoreOrg.js <orgId>
```

The script prints the restore report, including any client subs needing
re-subscription. It is safe to re-run.

Example result:

```json
{
  "restored": true,
  "purged": false,
  "domainsReset": 1,
  "clientSubsNeedingResubscribe": [
    { "clientEmail": "client@acme.co", "workspaceId": "…" }
  ]
}
```

## Verifying success

- `Organization.lifecycleStatus === 'active'` and all lifecycle fields
  (`suspendAt`, `suspendedAt`, `purgeAt`, `purgedAt`, `lifecycleReason`) cleared.
- Client workspaces remain `clientLocked === true` until each client re-subscribes
  (then their workspace unlocks automatically).
- Domains reach `active` (or are `pending_dns` awaiting the agency's re-verify).
- An audit entry `lifecycle.restored` records the report.
- Clients from `clientSubsNeedingResubscribe` have re-subscribed.

## Not recoverable here

- **Purged client data** (workspaces deleted after retention). Reactivating a
  purged org gives a working but empty shell. Full data recovery needs importing
  the tenant's export archive (Phase 18B) — a separate, not-yet-built pipeline.
- **Cancelled Stripe subscriptions.** Always re-created by the client, never by us.
