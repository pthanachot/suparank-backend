# AI Tracker — chaos runbook (test plan Phase 9)

Deliberate-failure drills that prove the recovery paths work. Each script is
self-contained (boots its own in-memory replset, seeds its own data, cleans
up), prints `PASS`/`FAIL` per assertion, and exits non-zero on any failure.

Run with Node ≥20.19 (`~/.nvm/versions/node/v22.12.0/bin/node`). None of them
touch a real database or a real vendor.

| # | Script | Simulates | Proves |
|---|--------|-----------|--------|
| 1 | `killMidScan.js` | `SIGKILL` between credit pre-deduct and settle | credits stick in `pending` → reconciliation flags → sweep refunds exactly → second sweep is a no-op (F4-13) |
| 2 | `vendorBrownout.js` | 429 / 5xx / timeout storms on every vendor call | scan completes instead of hanging, platform marked `error:true`, tracker terminal, money conserved, no non-terminal transactions |
| 3 | `mongoOutage.js` | the database disappearing mid-scan | `executeScan` settles rather than hanging, Phase H contains the failure, recovery tooling runs clean afterwards |

```bash
BIN=~/.nvm/versions/node/v22.12.0/bin/node
$BIN scripts/chaos/killMidScan.js      # ~30s
$BIN scripts/chaos/vendorBrownout.js   # ~40s
$BIN scripts/chaos/mongoOutage.js      # ~60s
```

`_scanChild.js` is a helper for #1 (a real `executeScan` against a stalling
vendor stub, so the parent can kill it at a controlled point) — not run
directly.

## When to run

- Before a release that touches `executeScan`, `creditService`, the scan
  engine's retry logic, or the recovery sweeps.
- After any change to the credit pre-deduct/settle/refund contract.
- Quarterly, as a standing check that the recovery paths still work.

## Known, accepted behaviours these drills document

- **A 429/5xx storm still bills `refresh-all`.** The scan is charged
  `5 × prompts scanned` even when every platform errored — refresh-all bills
  per prompt attempted, unlike single-refresh which refunds no-work prompts.
  Product decision, pinned in Phase 4 (`failures-state`) and re-observed here.
- **A DB outage mid-scan leaves the tracker mid-state** until the 30-minute
  stuck-scan sweep runs (`index.js` startup + cron). That sweep plus the
  orphan-credit sweep are the recovery path; drill #3 verifies both run clean
  against a recovered database.
