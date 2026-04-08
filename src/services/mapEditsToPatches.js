/**
 * Map Writing Engine edit operations to editor block patches.
 *
 * The Writing Engine returns edits as { old_string, new_string } pairs
 * (from EditTool). This function finds which block contains the old_string
 * and produces a patch operation the frontend can apply surgically
 * without replacing the entire document.
 *
 * Patch types:
 *   - "replace": update a block's text (old_string found in exactly one block)
 *   - "insert":  add new blocks after a target block
 *   - "delete":  remove a block
 */

const { stripHtml } = require('./blocksToMarkdown');

/**
 * Strip markdown inline formatting to produce plain text.
 * Handles: **bold**, *italic*, ~~strike~~, [text](url) → text
 * @param {string} md
 * @returns {string}
 */
function stripMarkdown(md) {
  if (!md) return '';
  let s = md;
  s = s.replace(/^#{1,6}\s+/, '');                    // ## heading → heading
  s = s.replace(/^>\s+/, '');                          // > quote → quote
  s = s.replace(/^[-*]\s+/, '');                       // - list → list
  s = s.replace(/^\d+\.\s+/, '');                      // 1. ordered → ordered
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');      // [text](url) → text
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');               // **bold** → bold
  s = s.replace(/__(.+?)__/g, '$1');                    // __bold__ → bold
  s = s.replace(/\*(.+?)\*/g, '$1');                    // *italic* → italic
  s = s.replace(/_(.+?)_/g, '$1');                      // _italic_ → italic
  s = s.replace(/~~(.+?)~~/g, '$1');                    // ~~strike~~ → strike
  return s;
}

/**
 * Map an array of Writing Engine edits to block patches.
 *
 * @param {Array<{old_string: string, new_string: string}>} edits - From EditTool
 * @param {Array<{id: string, type: string, text: string}>} blocks - Current editor blocks
 * @returns {Array<{op: string, blockId: string, [key: string]: any}>}
 */
function mapEditsToPatches(edits, blocks) {
  if (!edits || !Array.isArray(edits)) return [];
  if (!blocks || !Array.isArray(blocks)) return [];

  const patches = [];

  for (const edit of edits) {
    if (!edit.old_string || !edit.new_string) continue;
    if (edit.old_string === edit.new_string) continue;

    const patch = findPatchForEdit(edit, blocks);
    if (patch) {
      patches.push(patch);

      // Apply the patch to the blocks array so subsequent edits
      // match against the updated content (edits are sequential).
      applyPatchInPlace(patch, blocks);
    }
  }

  return patches;
}

/**
 * Find which block an edit applies to and produce a patch.
 *
 * Strategy:
 * 1. Try exact match in block plain text (stripped HTML)
 * 2. Try exact match in block HTML text
 * 3. Try match across heading text (for heading edits)
 *
 * @param {{old_string: string, new_string: string}} edit
 * @param {Array} blocks
 * @returns {Object|null} patch or null if no match
 */
function findPatchForEdit(edit, blocks) {
  const oldStr = edit.old_string;
  const newStr = edit.new_string;
  // Plain-text version of old_string (strips markdown **bold**, *italic*, etc.)
  const oldStrPlain = stripMarkdown(oldStr);

  // Strategy 1: Find block whose plain text contains the plain old_string
  for (const block of blocks) {
    const plainText = stripHtml(block.text || '');

    if (plainText.includes(oldStrPlain)) {
      // Replace in the HTML text using the plain text version
      const newStrPlain = stripMarkdown(newStr);
      const newHtml = replaceInHtml(block.text, oldStrPlain, newStrPlain);
      return {
        op: 'replace',
        blockId: block.id,
        text: newHtml,
      };
    }
  }

  // Strategy 2: Match raw old_string in HTML text (exact markdown in HTML)
  for (const block of blocks) {
    if ((block.text || '').includes(oldStr)) {
      return {
        op: 'replace',
        blockId: block.id,
        text: block.text.replace(oldStr, newStr),
      };
    }
  }

  // Strategy 3: Match across multiple blocks — not supported, return null.
  return null;
}

/**
 * Replace old_string in HTML text, preserving surrounding formatting.
 *
 * Strategy:
 * 1. If old_string appears literally in the HTML → direct replacement (fast path)
 * 2. If old_string is in the plain text but crosses HTML tag boundaries →
 *    strip all formatting from the block and replace in plain text.
 *    The AI's new_string may contain its own formatting.
 *
 * We intentionally DON'T try to do positional replacement across tag
 * boundaries — it creates broken HTML (unclosed tags). Losing formatting
 * on the edited block is an acceptable trade-off; the user can reformat.
 *
 * @param {string} html - Block's HTML text
 * @param {string} oldStr - Text to find
 * @param {string} newStr - Replacement text
 * @returns {string}
 */
function replaceInHtml(html, oldStr, newStr) {
  // Fast path: old_string appears literally in the HTML (no tag crossing)
  if (html.includes(oldStr)) {
    return html.replace(oldStr, newStr);
  }

  // old_string crosses tag boundaries — replace in plain text.
  // This strips formatting from this block but avoids broken HTML.
  const plain = stripHtml(html);
  return plain.replace(oldStr, newStr);
}

/**
 * Apply a patch to the blocks array in place.
 * This mutates the array so subsequent edits see updated content.
 *
 * @param {Object} patch
 * @param {Array} blocks
 */
function applyPatchInPlace(patch, blocks) {
  if (patch.op === 'replace') {
    const block = blocks.find((b) => b.id === patch.blockId);
    if (block) {
      block.text = patch.text;
    }
  }
}

module.exports = { mapEditsToPatches, findPatchForEdit, replaceInHtml };
