/**
 * HTML-escape a value destined for an email body.
 *
 * WHY THIS IS PER-CALLER AND NOT CENTRAL.
 *
 * The obvious fix for email HTML injection would be to escape inside
 * applyCustomTemplate (emailPortalController.js), which substitutes `data`
 * into templates with a raw `String(value)` replace. That is wrong: at least
 * one caller passes HTML on purpose. aiTrackerController builds
 * `platformRows` and `promptRows` as `<tr>...</tr>` fragments and expects them
 * to render as markup. Escaping centrally would turn the AI Tracker scan email
 * into a wall of visible tag soup.
 *
 * So the rule is: escape at the call site, on every value that came from a
 * user. aiTrackerController already did this with a local copy of this
 * function; this module is the shared home for it.
 *
 * Values that are safe unescaped: numbers, enum-checked strings, dates you
 * formatted yourself, and URLs you constructed. Note that escaping a URL is
 * still harmless inside an href, since `&amp;` is the correct HTML spelling of
 * `&` in an attribute and every client decodes it.
 */
function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip CR/LF so a crafted value cannot inject extra mail headers when it is
 * interpolated into a Subject, To, or Reply-To.
 */
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Reverse htmlEscape. `&amp;` is decoded LAST so an escaped entity round-trips:
 * "&lt;" escapes to "&amp;lt;" and must come back as "&lt;", not "<".
 */
function htmlUnescape(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Prepare a mail Subject.
 *
 * applyCustomTemplate substitutes ONE data bag into two different contexts: the
 * HTML body and the plain-text Subject. The values have to be HTML-escaped for
 * the body, which would otherwise leave entities in the subject line: an
 * ordinary "I can't log in" arrives in the support inbox as
 * "I can&#39;t log in", and apostrophes and ampersands are everywhere in real
 * support subjects.
 *
 * A Subject header is plain text (RFC 5322) and is never parsed as HTML, so
 * decoding the entities back is safe. The genuine header risk is CR/LF
 * injection, which headerSafe handles, and it runs AFTER the decode so a
 * payload cannot smuggle a newline through as "&#13;".
 */
function subjectSafe(value) {
  return headerSafe(htmlUnescape(value));
}

module.exports = { htmlEscape, headerSafe, htmlUnescape, subjectSafe };
