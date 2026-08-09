'use strict';

/**
 * Analytics event registry — the single source of truth for what
 * POST /api/observe stores (USAGE-TELEMETRY-PLAN.md §3.2, Wave 0).
 *
 * Replaces the hardcoded Set that lived in observeController: adding an event
 * is now a one-line, self-documenting change here, and the conformance test
 * (tests/observeRegistryConformance.test.js) parses the frontend's observe()
 * call sites and fails when an emitted name is missing from this registry —
 * the exact failure mode that silently dropped `ai_removed_restored`.
 *
 * `lane`: 'client' = emitted by the browser sink (consent-gated, lossy;
 *         numbers are lower bounds); 'server' = emitted via recordObservation()
 *         in a controller (complete).
 *
 * Enforcement semantics are unchanged from the original Set: unknown names
 * are silently dropped and the response is always 2xx (best-effort client).
 */
const EVENTS = Object.freeze({
  // ── Plan-mode observations (usePlanMode sink) ──────────────────────────
  plan_proposed: { lane: 'client', description: 'Plan mode proposed a plan {complete, failures, verifiedRefs}' },
  drift_observed: { lane: 'client', description: 'Execute-mode drift violations observed (non-empty only)' },
  time_to_approval: { lane: 'client', description: 'ms from plan_proposed to approve/reject' },
  plan_approval_rate: { lane: 'client', description: 'Plan outcome {outcome, turnCount}' },

  // ── Phase 7 product metrics ────────────────────────────────────────────
  ai_edit_applied: { lane: 'client', description: 'AI edit applied {rung, commandName?}' },
  ai_edit_reverted: { lane: 'client', description: 'AI edit reverted {rung, scope, commandName?}' },
  time_to_first_word: { lane: 'client', description: 'ms from run start to first streamed word' },
  analysis_recovered: { lane: 'server', description: 'Interrupted analysis recovered {attempts}' },

  // ── Wave 0 ─────────────────────────────────────────────────────────────
  // Was emitted by EditorChatBar.tsx:2907 but missing from the old Set —
  // silently discarded with a 200 {ok:true}. Registered here, not renamed.
  ai_removed_restored: { lane: 'client', description: 'User restored AI-removed content from a removal marker' },
  // F1: the consent CHOICE itself, deliberately exempt from the client sink's
  // analytics gate (it is consent record-keeping, not behavior) — without it,
  // the share of users whose [C]-lane telemetry is dropped is unmeasurable
  // and every client-lane dashboard number has an unknown correction factor.
  consent_choice: { lane: 'client', description: 'Cookie-banner choice {analytics, marketing} — the [C]-lane denominator' },

  // ── Wave 1 (§4b): server-side emits — complete, free-tier-safe ─────────
  // THE money emit: denials were HTTP responses recorded nowhere, yet the
  // first-wall analysis (which free-tier cap converts a signup) depends on
  // them. Emitted at the two gate choke points; flows into the daily rollup.
  quota_denied: { lane: 'server', description: 'Gate denial {action, gate: 429_quota|402_credits, tier, workspaceNumber, orgId}' },
  keyword_search: { lane: 'server', description: 'Keyword search {country, rows, cacheHit, workspaceNumber} — cache hits included' },
  keyword_detail_opened: { lane: 'server', description: 'Keyword SERP detail opened {cacheHit, workspaceNumber} — cache hits left zero trace before' },
  keyword_history_replayed: { lane: 'server', description: 'Saved research replayed from cache {workspaceNumber}' },
  keyword_history_deleted: { lane: 'server', description: 'Saved research deleted {workspaceNumber}' },
  readability_check_run: { lane: 'server', description: 'AEO readability check run {workspaceNumber} — route has no quota/credit trace' },
  import_url_succeeded: { lane: 'server', description: 'URL import succeeded {workspaceNumber, contentNumber} — authoritative (credit rows are free-tier-lossy)' },
  report_share_opened: { lane: 'server', description: 'Public report opened by an end client {shareId, orgId} — internal PDF renders excluded' },
  report_pdf_exported: { lane: 'server', description: 'Report PDF downloaded {workspaceNumber, period, orgId}' },
  onboarding_completed: { lane: 'server', description: 'Onboarding finished {answers} — answers become segmentation properties' },
  onboarding_skipped: { lane: 'server', description: 'Onboarding skipped' },

  // ── Wave 2 (§4a): editor + AI client events — all lower bounds ─────────
  editor_opened: { lane: 'client', description: 'Draft opened in SupaEditor {scoreAtOpen}' },
  editor_closed: { lane: 'client', description: 'Editor session ended {scoreAtOpen, scoreAtClose, durationMs, wordDelta}' },
  format_applied: { lane: 'client', description: 'Inline mark applied {mark, via: toolbar|floating|shortcut} — via the applyMark choke point' },
  slash_menu_opened: { lane: 'client', description: 'Block slash-menu opened' },
  slash_menu_item_selected: { lane: 'client', description: 'Slash-menu block chosen {item, query} — query captured before the filter clears' },
  toolbar_button_clicked: { lane: 'client', description: 'Top-toolbar action {button} — single onFormat funnel' },
  floating_toolbar_action: { lane: 'client', description: 'Floating-toolbar action {action}' },
  version_restored: { lane: 'client', description: 'Version history restore — the heaviest undo the product has' },
  import_url_submitted: { lane: 'client', description: 'Import-URL modal submitted (UX funnel; import_url_succeeded is authoritative)' },
  import_url_result: { lane: 'client', description: 'Import-URL outcome as the user saw it {ok}' },
  ai_chat_message_sent: { lane: 'client', description: 'User message sent to editor AI (top of handleSubmit — every send path)' },
  slash_command_run: { lane: 'client', description: 'Slash command executed {command, via: chip|typed|palette}' },
  ai_run_stopped_by_user: { lane: 'client', description: 'User stopped a live run {elapsedMs, runId, commandName} — programmatic aborts excluded' },
  inline_action_used: { lane: 'client', description: 'Inline AI action requested {action: rewrite|expand|shorten|…}' },
  inline_action_applied: { lane: 'client', description: 'Inline AI preview accepted {action}' },
  inline_action_reverted: { lane: 'client', description: 'Inline AI preview rejected {action} — regret signal' },
  steer_sent: { lane: 'client', description: 'Mid-run steering message injected' },
  clarify_answered: { lane: 'client', description: 'Clarify popup answered {timeToAnswerMs}' },
  image_generated: { lane: 'client', description: 'AI image generation attempted from ImageBlock {ok}' },
  plan_action: { lane: 'client', description: 'Plan decision {action: approve|reject|reopen} — discrete twin of plan_approval_rate' },
  sidebar_panel_opened: { lane: 'client', description: 'Sidebar panel/tab opened {tab} — one event, five tab-state hooks' },
  internal_link_inserted: { lane: 'client', description: 'Internal-link suggestion inserted {targetUrl, anchor}' },
  // Wave 5 Phase 6: the outline review is the one place a human visibly
  // corrects the engine, and until now approving it recorded nothing.
  outline_approved: { lane: 'client', description: 'Outline review approved {depth, sections}' },
  track_keyword_clicked: { lane: 'client', description: 'Track-keyword card {stage: intent|confirmed}' },

  // ── Wave 3 (§4a): shell + feature-area client events ───────────────────
  nav_item_clicked: { lane: 'client', description: 'Dashboard sidebar navigation {item}' },
  workspace_switched: { lane: 'client', description: 'Active workspace changed {workspaceNumber}' },
  org_switched: { lane: 'client', description: 'Organization switched via OrgSwitcher (user intent only — programmatic switches uncounted)' },
  notification_bell_opened: { lane: 'client', description: 'Notification bell panel opened' },
  notification_bell_item_clicked: { lane: 'client', description: 'Notification item followed {type?}' },
  upgrade_clicked: { lane: 'client', description: 'Upgrade link clicked {surface} — the 6 real link sites' },
  settings_tab_viewed: { lane: 'client', description: 'Settings tab viewed {tab} — pathname effect in SettingsLayout' },
  checkout_started: { lane: 'client', description: 'Stripe Checkout initiated {surface} — portal redirects excluded' },
  onboarding_answer_selected: { lane: 'client', description: 'Onboarding question answered {step, choice} — last step = drop-off point' },
  filter_applied: { lane: 'client', description: 'Content-list view changed {tab, search, sort} — debounced URL-sync' },
  keyword_exported: { lane: 'client', description: 'Keyword results exported to xlsx {rows}' },
  keyword_to_article_clicked: { lane: 'client', description: 'Keyword → article handoff — the funnel bridge' },
  tracker_setup_step_reached: { lane: 'client', description: 'Tracker onboarding step reached {step}' },
  suggested_prompts_accepted: { lane: 'client', description: 'Setup finished {offered, accepted} — suggestion quality' },
  engine_filter_toggled: { lane: 'client', description: 'Tracker engine filter toggled {engine}' },
  tracker_export_downloaded: { lane: 'client', description: 'Tracker CSV export downloaded' },
  gsc_connect_clicked: { lane: 'client', description: 'GSC connect initiated {rewire?} — completion derives from GscConnection' },
  site_tab_viewed: { lane: 'client', description: 'Site detail tab viewed {tab}' },
  csv_exported: { lane: 'client', description: 'Site data CSV exported {tab}' },
  opportunity_optimize_clicked: { lane: 'client', description: 'Striking-distance opportunity → optimize clicked' },
  report_viewed: { lane: 'client', description: 'Client report viewed in-app {period}' },

  // ── Wave 3 friction (one listener each, app-wide) ──────────────────────
  error_shown: { lane: 'client', description: 'Error toast shown {surface: route} — one hook in Toast' },
  loading_exceeded: { lane: 'client', description: 'Shared spinner visible >3s {ms, surface: route}' },
  rage_click: { lane: 'client', description: '3+ rapid clicks on one target {selector} — confusion evidence' },
});

const ALLOWED_EVENTS = new Set(Object.keys(EVENTS));

module.exports = { EVENTS, ALLOWED_EVENTS };
