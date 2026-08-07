# MongoDB cutover plan

Goal: move the backend to a new MongoDB instance, with the switch itself reduced
to a boring env-var change. `MONGODB_URI` + `DB_NAME` must be the only things
that decide where data goes. Note: the app selects its database via the
`dbName` connect option (`DB_NAME`, default `suparank`) — **not** the URI path.

## Phase 1 — Make the code follow env everywhere

- [x] `setup-downgrade-test.js` — remove the hardcoded staging URI + credential;
      read `MONGODB_URI` / `DB_NAME` from env like everything else.
- [x] Replace hardcoded `dbName: 'suparank'` with `process.env.DB_NAME || 'suparank'`:
      `src/scripts/migrateToOrganizations.js`, `src/scripts/migrateCreatedOnPlan.js`,
      `src/scripts/verifyNotificationIndexes.js`.
- [x] Add the missing `dbName` option (currently these land in the default `test`
      db when the URI has no path): `src/scripts/migrateSubscriptionsToOrg.js`,
      `src/scripts/dedupeSitemaps.js`, `scripts/reconcileTrackerCredits.js`,
      `scripts/preflightImage.js`.
- [x] Retire the `MONGO_URI` alias (dedupeSitemaps, reconcileTrackerCredits);
      unify `MONGODB_TEST_URI` → `MONGO_TEST_URI` (planModel.test.js).

## Phase 2 — Env-file hygiene and credential safety

- [x] Make `.env` the single source of truth: Mongo lines removed from
      `.env.local` (replaced with a pointer comment); the `.env.local`-first
      load order used by `scripts/preflightImage.js` / `scripts/smokeVendors.js`
      / eval tools now falls through to `.env` (verified). Load-order warning
      documented in `.env.example`.
- [x] Delete the four stale `.env*.bak` files holding the live credential.
      (Checked first: the only var name unique to them was `CHATGPT_SEARCH_KEY`
      — unused by the backend; the Go engine reads it but carries its own copy
      in `engine/.env`, so nothing was lost.)
- [x] Rotation SUPERSEDED by decision (2026-08-07): the cutover targets a
      brand-new cluster with a fresh, never-leaked credential, so the old
      password is not rotated. The leaked `octgram-staging` credential stays
      valid on the OLD cluster until Phase 5 deletes that user — keep the gap
      between cutover and decommission short. (If the old cluster must outlive
      the cutover for long, rotate its password right after the final dump.)
- [x] Update `.env.example`: path-less `MONGODB_URI`, `DB_NAME`, and a comment
      that `DB_NAME` — not the URI path — selects the database. Also
      un-gitignored `.env.example` (`!.env.example`) so the template ships with
      the repo — verified placeholder-only first.

## Phase 3 — Harden cutover-sensitive machinery

- [x] `src/services/backupService.js` — URIs are normalized to path-less form
      (`stripUriPath`, exported + tested) so `--db` stays valid even if the URI
      carries a database path; archives are now named `<DB_NAME>-<stamp>` so
      per-database dumps stay distinguishable. (No consumer parses the old
      `suparank-` prefix — records store the full path.)
- [x] Preflight script: `scripts/preflightDb.js` (gitignore re-include added).
      Read-only go/no-go gate: host + db identity, replica-set/mongos topology,
      a REAL read-only transaction probe, sentinel collection counts
      (`--expect-empty` for a fresh pre-restore cluster), and
      mongodb-database-tools version vs server version. Exit 0 GO / 1 NO-GO /
      2 no-connect. To vet the NEW cluster before first boot:
      `MONGODB_URI='mongodb+srv://…' node scripts/preflightDb.js --expect-empty`
      (real env vars win over `.env` — dotenv never overrides).
      Verified live against staging: GO (replica set, server 8.0.29,
      mongodump 100.12.1, 302 sentinel docs).

## Phase 4 — The cutover

Schedule outside the 03:00–04:30 cron window so no job straddles the switch.

New-cluster prerequisites: create the database user with a **fresh password**
(never reuse the leaked one), keep the URI **path-less** (`DB_NAME` selects the
database), use Atlas / a replica set (creditService transactions fail on a
standalone mongod), and set the **IP access list** to cover both the operator's
machine and Railway's egress. Env changes are applied manually by the owner: the owner directly replaces
`MONGODB_URI` in `.env` and in the Railway Variables tab (no staging var —
in-place swap by decision, 2026-08-07). The old URI remains recoverable from
git history (`HEAD:setup-downgrade-test.js`) until Phase 5 decommissions the
old user, so an in-place swap cannot strand the old cluster.

**DECIDED (2026-08-07): fresh start — the new database begins empty, old data
is abandoned.** With no data to carry over there is no freeze, no dump, no
restore, and no timing window: writes still hitting the old cluster after the
swap are discarded along with it. Steps 1–3 below are SKIPPED; they are kept
only as the reference procedure if a data-carrying migration is ever needed.

Fresh-start procedure: swap the URI, run
`npm run preflight:db -- --expect-empty` (must say GO), boot — configSync
seeds settings into the empty database. Then continue at step 4.

1. **Stop every backend process — pause/stop the Railway service and any local
   dev server.** This is the write freeze. Maintenance mode is NOT sufficient:
   `/api/auth`, `/api/admin`, `/api/internal` are exempt, Stripe webhooks
   bypass the gate entirely, and in-process cron jobs ignore HTTP middleware.
   Stopping the backend stops every writer at once (the Go engine only writes
   through `/api/internal`). Stripe retries webhooks for days, so a short stop
   loses nothing.
2. Final `mongodump` of the old cluster. Record the sentinel counts printed by
   `npm run preflight:db` at this moment — they are the restore baseline.
3. Swap `MONGODB_URI`, then `mongorestore` into the new instance; run
   `npm run preflight:db` (no flag) and compare sentinel counts against the
   step-2 baseline — they must match exactly (nothing can write during the
   freeze). Verify *before* first boot: boot immediately runs `syncIndexes`,
   a stuck-scan `updateMany`, and config seeding.
4. Mirror the new `MONGODB_URI` into the **deployed (Railway) env** — never
   `.env.local`: Phase 2 removed Mongo vars there, and re-adding them would
   silently shadow `.env` for the `.env.local`-first tools. The local file
   does not affect a deployed server. `DB_NAME` stays `suparank` (and its
   absence on Railway is safe — the code defaults to `suparank`). Set
   `EXPECTED_DB_HOST` in both places at the same time — it arms the Phase 5
   wrong-cluster guardrail. Pick a value that actually distinguishes the two
   clusters: the Atlas `<projecthash>.mongodb.net` suffix is per PROJECT and
   is shared when old + new clusters live in one project — in that case use
   the new cluster's `ac-<token>` host prefix (from the `MongoDB connected:`
   boot log line), or create the new cluster in its own Atlas project.
5. Restart; confirm the boot log line `MongoDB connected: <host>/<name>` shows
   the new cluster (Railway logs for the deployed instance) and `/health`
   returns `expectedHostMatch: true`; run `npm run preflight:db` once more
   plus a manual login/smoke pass.

**Rollback (any failure in steps 2–5):** the old cluster is untouched after
the freeze — abort by leaving (or reverting) `MONGODB_URI` at the old value,
restart against the old cluster, and retry another night. Nothing is lost;
do NOT decommission anything (Phase 5) until the new cluster has survived a
full cron cycle.

## Phase 5 — Post-cutover verification and guardrails

- [ ] Trigger one admin backup; confirm it dumps from the new cluster. Archive
      or delete the old-cluster dump in `backups/`.
- [ ] Watch the first 03:00–04:30 cron cycle (scans, credit grants, retention
      purge, lifecycle suspend) and sanity-check counts the next morning.
- [ ] Decommission the old cluster's user/credential entirely — deleting the
      `octgram-staging` user is what finally closes the git-history leak of its
      password (rotation was consciously skipped in Phase 2 because of this
      step).
- [x] Guardrail IMPLEMENTED (ahead of cutover): `src/config/database.js` warns
      loudly at boot when the connected host doesn't contain
      `EXPECTED_DB_HOST` (substring match — SRV URIs resolve to per-shard
      hostnames), and `/health` now reports `expectedHostMatch` so a
      wrong-cluster deploy is visible remotely. Unset var = check disabled;
      listed in `requireEnv` optional so its absence is noted at boot.
      Armed by cutover step 4 setting it in `.env` + Railway.
