/**
 * Zod schemas for sitemap endpoints.
 *
 * One schema per endpoint. The middleware (validateBody) returns 400 with
 * field-level errors when the request body doesn't match — replacing the
 * old pattern of in-controller `if (!field) return 400` chains.
 *
 * This file is the reference template for rolling out Zod across the rest
 * of the API. Each new validator file should follow the same shape:
 *   - one named export per endpoint schema
 *   - field-level `.url()`, `.min()`, `.max()`, etc. for declarative validation
 *   - human-readable error messages that match what the old controllers used
 */

const { z } = require('zod');

// POST /api/workspace/:wn/sitemaps
//
// The controller normalizes URLs (adds https://, strips trailing slash) so
// we accept loose input here — just confirm it's a string with at least a
// hostname. The crawler-level `new URL()` validation in createSitemap will
// catch the remaining bad cases (BUG #9 fix).
const createSitemapSchema = z.object({
  url: z
    .string({ required_error: 'url is required' })
    .min(1, 'url is required')
    .max(2048, 'url too long (max 2048 chars)'),
  label: z.string().max(255).optional(),
  schedule: z.enum(['daily', 'weekly', 'monthly']).optional(),
});

module.exports = { createSitemapSchema };
