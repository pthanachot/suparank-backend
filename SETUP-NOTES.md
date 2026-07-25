# Setup Notes for Team

## After pulling latest changes

### Private B2 Image Storage (presigned URLs)

**Run in the backend repo:**
```
npm install
```

This installs the new `@aws-sdk/s3-request-presigner` package (needed for generating signed URLs for the private B2 bucket).

**New environment variables** (add to your `.env`):
```
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_BUCKET=your-bucket-name
B2_KEY_ID=your-application-key-id
B2_APP_KEY=your-application-key
B2_CDN_URL=                # optional, leave empty if not using a CDN
```

If these are not set, B2 storage is disabled and images fall back to base64 in MongoDB (same as before).

**Bucket must be PRIVATE** — no public read access. Images are served via presigned URLs that expire after 1 hour (auto-refreshed on each request).

---

## Platform admins — env-only (up to 5 slots)

Admin identity is controlled **only** by Railway environment variables. There is
no in-app "add/remove admin" — the Settings → Admin Accounts panel is read-only.

**Railway variables** (set on the backend service):

```
ADMIN_EMAILS=alice@you.com     # slot 1 (also comma-tolerant, e.g. a@x.com,b@x.com)
ADMIN_EMAILS_2=bob@you.com     # slots 2–5 are optional, one admin each
ADMIN_EMAILS_3=
ADMIN_EMAILS_4=
ADMIN_EMAILS_5=
```

- Emails are matched case-insensitively; blank slots are ignored.
- The same allowlist also governs who can be **impersonated** — an admin email
  can never be an impersonation target.
- To grant or revoke admin access: edit the variables and redeploy. Role claims
  (`roles: ['admin']`) are **not** honored — only these env slots are.

**Cutover ordering (one-time, when migrating off the old DB-managed list):**

1. Run the migration read against the target DB — it lists any admin who exists
   only in the deprecated `SystemSettings.adminEmails` and would be orphaned:
   ```
   node src/scripts/auditDbAdminEmails.js
   ```
2. Fold any `DB-ONLY` emails it reports into the Railway slots above.
3. Deploy the env-var change **together** with the code cutover. Setting the
   slots before the code, or the code before the slots, risks a window where a
   DB-only admin loses access.

---

## Admin audit log

Every mutating platform-admin action is recorded to the `AdminAuditLog`
collection (actor, action, target, before/after diff, ip). Read/exported from
the dashboard's **Audit Log** tab (`GET /api/admin/audit-log[/export]`).

- **Append-only:** there is no API to edit or delete entries (the read routes are
  GET-only); the model has no `updatedAt`.
- **Retention:** entries auto-expire after **730 days** via a TTL index
  (`AdminAuditLog.RETENTION_DAYS`).
- **Indexes:** Mongoose builds indexes lazily and `autoIndex` is typically OFF in
  production, so on first deploy of this feature build the AdminAuditLog indexes
  (the four query indexes + the TTL):
  ```
  node src/scripts/verifyAdminAuditIndexes.js          # report
  node src/scripts/verifyAdminAuditIndexes.js --sync   # create / reconcile
  ```
  Without the TTL, rows accumulate forever; without the feed/actor/action/target
  indexes, the Audit Log tab's queries scan.
