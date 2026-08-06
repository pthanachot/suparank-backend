# AI Tracker — observability & alerting (test plan Phase 9)

What the system emits, and what should page someone. Before Phase 9 a
successful scan was **silent** (F4 §8.1) — you could not answer "did the 3 AM
sweep run?" or "why did billing spike?" from logs alone.

## The two summary lines

**Engine, per scan** (`aiTrackerScanEngine.js`, end of `runScan`):

```
[ai-tracker] scan complete: prompts=12 platforms=4 errors=1 words=8421 competitors=7 \
  durationMs=184300 analyzerCalls=48 fallbacks=0 fallbackRate=0%
```

**Controller, per scan** (`aiTrackerController.js`, success exit of `executeScan`):

```
[ai-tracker-scan] COMPLETE tracker=<id> action=trackerRefreshAll durationMs=186900 \
  prompts=12 platforms=4 errors=1 fallbackRate=0% credits=60 scanId=<id>
```

`COMPLETE` is the line to grep for "did this scan finish, and what did it
cost". `credits=` is the settled amount, so summing it over a day reconciles
against the credit ledger.

## Alert conditions

| Condition | Signal | Why it matters |
|---|---|---|
| **`fallbackRate` > 5% sustained** | `COMPLETE`/engine lines, or `analyzeResponse fallback engaged` warnings | The analyzer is degraded (dead key, vendor outage). Every downstream metric silently loses position, brand ranking and sentiment — data looks normal but is wrong (F3-13). **Currently firing in dev: the OpenRouter key returns 401.** |
| **Zero `COMPLETE` lines in 24h** (with active trackers) | absence | The cron never ran, or every scan is failing before the success exit. Absence-of-signal needs an explicit check — nothing else reports it. |
| **Any `refund failed`** | `console.error` in creditService/executeScan | Money is stuck. Pair with `scripts/reconcileTrackerCredits.js`. |
| **Any `settle failed`** | `console.error` | Scan results are discarded (S74) and the user was charged pending a refund. |
| **`errors=` ≥ platform count** (all platforms failing) | `COMPLETE` line | Vendor outage or key revocation — cross-check with the daily smoke. |
| **`durationMs` p95 doubling week-over-week** | `COMPLETE` line | Vendor latency creep or the F4-08 write fan-out regressing; `perf-smoke.test.js` guards the write side in CI. |
| **Smoke exit ≠ 0** | `scripts/smokeVendors.js` | Model deprecation, key expiry, or a response-schema change — the drift the mocked suites structurally cannot see. |
| **Reconciliation exit ≠ 0** | `scripts/reconcileTrackerCredits.js` | Orphaned pre-deductions, stuck settle/refund claims, or negative pools. |

## Scheduled jobs

```bash
BIN=~/.nvm/versions/node/v22.12.0/bin/node
# daily — vendor drift tripwire (real, billed calls; alert on non-zero exit)
SMOKE=1 $BIN scripts/smokeVendors.js --json
# nightly — ledger health against the dev database
MONGODB_URI=... $BIN scripts/reconcileTrackerCredits.js
```

## Known gaps (deliberate, not oversights)

- **No structured logging.** Lines are free-form text with `key=value`
  fields, greppable but not JSON. Fine for the current single-instance dev
  deployment; revisit before multi-instance production.
- **No per-tracker latency histogram.** `durationMs` per scan is enough to
  spot regressions; percentiles need log aggregation.
- **No metric for scans that skipped as not-due** — the cron logs those
  separately (`No prompts due …`), and they are the normal case.
