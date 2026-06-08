/**
 * Generic Zod-based request body validator.
 *
 * Usage:
 *   const { createSitemapSchema } = require('../validators/sitemapValidators');
 *   router.post('/sitemaps', validateBody(createSitemapSchema), handler);
 *
 * On success: replaces req.body with the parsed (coerced + defaults applied)
 * value, then calls next().
 *
 * On failure: returns 400 with field-level details. Schema authors can shape
 * the messages; clients see e.g.
 *   { error: "Invalid request body", code: "VALIDATION_ERROR",
 *     issues: [{ path: "url", message: "Invalid URL format" }] }
 *
 * Replaces ad-hoc per-controller checks ("if (!url) return 400; if (!url.match(...))
 * return 400; ...") with one declarative schema per endpoint.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return res.status(400).json({
        error: 'Invalid request body',
        code: 'VALIDATION_ERROR',
        issues,
      });
    }
    req.body = result.data;
    return next();
  };
}

module.exports = validateBody;
