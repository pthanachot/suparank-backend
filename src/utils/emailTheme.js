/**
 * Design tokens for transactional email.
 *
 * These live in utils/ rather than in emailPortalController because two
 * unrelated modules need them: the controller (templates, shell, buttons) and
 * utils/scanEmailRows (the AI-Tracker table fragments). A controller→controller
 * require to share a string constant would be the wrong dependency.
 *
 * Values mirror the app's design system:
 *   FONT_STACK    ← --sr-sans        (workspace.css)
 *   TRACKING_BODY ← .suparank-shell letter-spacing
 *   EMAIL_WIDTH   ← the one canonical body width (plan D6)
 *
 * The full colour ramp is NOT duplicated here — colours stay literal in the
 * markup, guarded by tests/emailDesignTokens.test.js. See plan decision D1.
 */

/**
 * The app's `--sr-sans`, expanded for mail clients.
 *
 * Inter is NOT webfont-loaded: Gmail strips `@import` and `<link>`. Naming it
 * first lets Apple Mail, iOS and Outlook-macOS resolve the stack to something
 * far closer to Inter than Arial; everyone else falls through to Arial exactly
 * as before. `ui-sans-serif`/`system-ui` from the app token are dropped — no
 * mail client understands them.
 */
const FONT_STACK = `'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** The app's body tracking (`.suparank-shell`, -0.011em). */
const TRACKING_BODY = '-0.011em';

/** One canonical body width — previously 480 (×4) / 600 (×9) / 640 (×1). */
const EMAIL_WIDTH = 600;

module.exports = { FONT_STACK, TRACKING_BODY, EMAIL_WIDTH };
