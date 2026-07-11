# Data Processing Inventory (Phase 18C)

A record of the personal / customer data SupaRank stores, where it lives, why we
hold it, and how it is deleted. It backs agency Data Processing Agreements (DPAs)
and GDPR Article 30 records-of-processing obligations. Keep it in sync with the
scoping map in `src/services/deletionService.js` — **any new collection that holds
tenant data must be added to both.**

Roles: for an agency reselling SupaRank to its own clients, the **agency is the
data controller** for its clients' content, SupaRank is a **processor**. For the
agency's own account data, SupaRank is the controller.

## Retention & deletion at a glance

| Path | Trigger | What is deleted | Timing |
|------|---------|-----------------|--------|
| Client erasure | `DELETE /:workspaceNumber/erase` (owner/admin, name-confirmed) | One workspace + all its scoped data | Immediate |
| Agency account closure | `DELETE /organizations/:orgId/erase` (owner only, name-confirmed) | Entire org: all workspaces + org-scoped data + the org record | Immediate |
| Retention purge | Cron `runDuePurges` (suspended org, `purgeAt` elapsed) | The suspended agency's **client-provisioned** workspaces | 90 days after suspension |
| Audit trail | `AuditLog` TTL index | Audit entries | Auto-expire (TTL); **never** hard-deleted by erasure |

All three deletion paths are gated behind the dark `dataErasure` feature flag and
ship inert. Erasure does **not** archive — callers should export (Phase 18B,
`dataExport`) first if they need a copy.

## Data categories

### Per-workspace (deleted by `deleteWorkspaceData`)

| Category | Collection(s) | Scope field | Purpose |
|----------|---------------|-------------|---------|
| Content / articles | `Content`, `Plan`, `AgentUsageLog` | `workspaceId` (+ `contentId`) | The customer's authored content and generation history |
| AI visibility tracking | `AiTracker`, `AiTrackerPrompt`, `AiTrackerScan`, `AiTrackerCompetitor` | `workspaceId` / `trackerId` | Brand-visibility monitoring the customer configured |
| Keyword research | `KeywordResearchHistory` | `workspaceId` | Saved keyword lookups |
| Reports | `ReportSnapshot`, `ReportShare` | `workspaceId` | Generated performance reports + share links |
| Site / crawl data | `Site`, `Sitemap`, `CrawlPage` | `workspaceId` / `sitemapId` | Connected-site crawl + sitemap data |
| Brand assets | `BrandVoice`, `Avatar` | `workspace` | Brand voice profiles and avatars |
| Membership & usage | `WorkspaceMember`, `WorkspaceUsageTracker` | `workspaceId` | Who can access the workspace + per-period quota counters |
| Pending invites | `Invite` | `workspaceIds` (array) | Unaccepted invitations targeting the workspace (holds invitee email) |
| Client billing | `ClientSubscription` | `workspaceId` | The client's subscription (also canceled on Stripe before deletion) |

### Per-org (additionally deleted by `deleteOrgData`)

| Category | Collection(s) | Scope field | Purpose |
|----------|---------------|-------------|---------|
| Agency plans / pricing | `AgencyPlan` | `organizationId` | The reseller's client-facing plan catalog |
| Branding | `BrandConfig` | `organizationId` | White-label brand config (also reverted on suspend) |
| Credits & billing | `Credit`, `CreditTransaction`, `Subscription` | `organizationId` | Credit balance/ledger + the agency's platform subscription (canceled on Stripe before deletion) |
| Custom domains | `Domain` | `organizationId` | Tenant domains (Cloudflare hostnames removed before deletion) |
| Integrations | `GscConnection` | `organizationId` | Google Search Console connections |
| Members & invites | `OrgMember`, `Invite` | `organizationId` | Org membership + pending invites |
| Email templates | `TriggerableEmailTemplate` | `organizationId` | Custom lifecycle email templates |
| Usage counters | `UsageTracker` | `organizationId` | Org-level quota counters |

### Deliberately NOT deleted

| Data | Where | Why retained |
|------|-------|--------------|
| Audit log | `AuditLog` | Compliance/accountability trail (proof of the deletion itself). TTL-expires on its own schedule. |
| User account | `User` | The org owner may own or belong to other organizations; erasing an org must not delete the person. Delete a `User` only on a dedicated account-deletion request. |
| Stripe / Cloudflare records | External | Erasure cancels Stripe subs and removes Cloudflare hostnames best-effort, but Stripe retains its own records per its retention policy. |

## Operational notes

- **Coverage is manual.** `deletionService` enumerates collections explicitly. A
  new tenant-scoped model that is not added leaves orphaned data (an incomplete
  erasure). The service header and this file both flag that requirement.
- **Idempotent.** Every deletion re-runs cleanly; the purge marks `purgedAt` and
  clears `purgeAt` so a suspended org is purged once.
- **Best-effort external teardown.** Stripe-cancel and Cloudflare-delete failures
  are logged but do not block record deletion (the record carries the personal
  data). On the purge path these are already torn down by `suspend()`.
