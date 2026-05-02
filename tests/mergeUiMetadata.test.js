/**
 * mergeUiMetadata is defined inside aiController.js and not exported.
 * We replicate it here for isolated testing. If the function changes,
 * update this copy to match.
 */
function mergeUiMetadata(oldBlocks, newBlocks) {
  const result = [...newBlocks];

  // 1. Carry forward image width/align
  for (const newB of result) {
    if (newB.type === 'img' && newB.src) {
      const oldB = oldBlocks.find(
        (ob) => ob.type === 'img' && ob.src === newB.src,
      );
      if (oldB) {
        if (oldB.width) newB.width = oldB.width;
        if (oldB.align) newB.align = oldB.align;
      }
    }
  }

  // 2. Re-insert toc blocks
  const tocBlocks = oldBlocks.filter((b) => b.type === 'toc');
  if (tocBlocks.length > 0 && !result.some((b) => b.type === 'toc')) {
    const h1Idx = result.findIndex((b) => b.type === 'h1');
    const insertIdx = h1Idx >= 0 ? h1Idx + 1 : 0;
    for (const toc of tocBlocks) {
      result.splice(insertIdx, 0, { ...toc });
    }
  }

  // 3. Re-insert cta blocks
  const ctaBlocks = oldBlocks.filter((b) => b.type === 'cta');
  if (ctaBlocks.length > 0 && !result.some((b) => b.type === 'cta')) {
    for (const cta of ctaBlocks) {
      result.push({ ...cta });
    }
  }

  return result;
}

// ── Tests ───────────────────────────────────────────────────

describe('mergeUiMetadata', () => {
  test('carries forward image width and align from old blocks', () => {
    const old = [
      { id: '1', type: 'img', src: 'https://example.com/a.png', width: 500, align: 'center' },
    ];
    const newBlocks = [
      { id: '2', type: 'img', src: 'https://example.com/a.png' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    expect(result[0].width).toBe(500);
    expect(result[0].align).toBe('center');
  });

  test('does not carry forward if image src does not match', () => {
    const old = [
      { id: '1', type: 'img', src: 'https://example.com/a.png', width: 500 },
    ];
    const newBlocks = [
      { id: '2', type: 'img', src: 'https://example.com/b.png' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    expect(result[0].width).toBeUndefined();
  });

  test('re-inserts TOC block after H1 when AI drops it', () => {
    const old = [
      { id: '1', type: 'h1', text: 'Title' },
      { id: '2', type: 'toc', text: '' },
      { id: '3', type: 'p', text: 'Content' },
    ];
    const newBlocks = [
      { id: '4', type: 'h1', text: 'Title' },
      { id: '5', type: 'p', text: 'Content' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    // TOC should be inserted after H1 (index 1)
    expect(result.length).toBe(3);
    expect(result[1].type).toBe('toc');
  });

  test('does not duplicate TOC if new blocks already have one', () => {
    const old = [
      { id: '1', type: 'h1', text: 'Title' },
      { id: '2', type: 'toc', text: '' },
    ];
    const newBlocks = [
      { id: '3', type: 'h1', text: 'Title' },
      { id: '4', type: 'toc', text: '' },
      { id: '5', type: 'p', text: 'Content' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    const tocs = result.filter((b) => b.type === 'toc');
    expect(tocs).toHaveLength(1);
  });

  test('re-inserts CTA blocks at end when AI drops them', () => {
    const old = [
      { id: '1', type: 'p', text: 'Content' },
      { id: '2', type: 'cta', text: '', ctaData: { buttonText: 'Sign Up', url: '/signup' } },
    ];
    const newBlocks = [
      { id: '3', type: 'p', text: 'New content' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    expect(result.length).toBe(2);
    expect(result[result.length - 1].type).toBe('cta');
    expect(result[result.length - 1].ctaData.buttonText).toBe('Sign Up');
  });

  test('does not duplicate CTA if new blocks already have one', () => {
    const old = [
      { id: '1', type: 'cta', text: '', ctaData: { buttonText: 'Join' } },
    ];
    const newBlocks = [
      { id: '2', type: 'p', text: 'Text' },
      { id: '3', type: 'cta', text: '', ctaData: { buttonText: 'Join' } },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    const ctas = result.filter((b) => b.type === 'cta');
    expect(ctas).toHaveLength(1);
  });

  test('inserts TOC at position 0 when no H1 exists', () => {
    const old = [
      { id: '1', type: 'toc', text: '' },
      { id: '2', type: 'h2', text: 'Section' },
    ];
    const newBlocks = [
      { id: '3', type: 'h2', text: 'Section' },
      { id: '4', type: 'p', text: 'Text' },
    ];
    const result = mergeUiMetadata(old, newBlocks);
    expect(result[0].type).toBe('toc');
  });

  test('does not mutate the original newBlocks array', () => {
    const old = [
      { id: '1', type: 'toc', text: '' },
    ];
    const newBlocks = [
      { id: '2', type: 'p', text: 'Text' },
    ];
    const originalLength = newBlocks.length;
    mergeUiMetadata(old, newBlocks);
    expect(newBlocks).toHaveLength(originalLength);
  });
});
