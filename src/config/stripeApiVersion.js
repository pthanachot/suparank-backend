/**
 * Pinned Stripe API version — the SINGLE source for every `new Stripe(...)` in
 * the app (legacy billing/webhook/user/admin controllers, the Connect
 * stripeService, and the cutover scripts).
 *
 * Pinning keeps response shapes stable across Stripe SDK/account upgrades: an
 * unpinned client uses the account's default API version, which can change
 * under you (e.g. `current_period_end` moving onto `items.data[0]`) and silently
 * break parsing on the live account. Matches the version bundled with the
 * installed stripe SDK (types/apiVersion.d.ts).
 */
module.exports = '2026-02-25.clover';
