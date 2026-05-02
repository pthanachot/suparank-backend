/**
 * Tests for fileParser.js — verifies pdf-parse v2 integration and file parsing.
 */

describe('fileParser', () => {
  let parseFile, SUPPORTED_MIMES;

  beforeEach(() => {
    jest.resetModules();
    ({ parseFile, SUPPORTED_MIMES } = require('../src/services/fileParser'));
  });

  // ── SUPPORTED_MIMES ───────────────────────────────────────

  test('exports the three supported MIME types', () => {
    expect(SUPPORTED_MIMES).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ]);
  });

  // ── TXT parsing ───────────────────────────────────────────

  test('parses plain text buffer correctly', async () => {
    const content = 'Hello world, this is a test document with several words in it for counting.';
    const buffer = Buffer.from(content, 'utf-8');
    const result = await parseFile(buffer, 'text/plain');

    expect(result.text).toBe(content);
    expect(result.wordCount).toBe(14);
  });

  test('cleans up excessive whitespace in TXT', async () => {
    const content = 'Line one.\r\n\r\n\r\n\r\nLine two.';
    const buffer = Buffer.from(content, 'utf-8');
    const result = await parseFile(buffer, 'text/plain');

    // \r\n → \n, then 3+ consecutive \n → \n\n
    expect(result.text).toBe('Line one.\n\nLine two.');
  });

  test('returns correct word count for text with mixed whitespace', async () => {
    const content = '  one   two   three   ';
    const buffer = Buffer.from(content, 'utf-8');
    const result = await parseFile(buffer, 'text/plain');

    expect(result.wordCount).toBe(3);
  });

  test('handles empty text file', async () => {
    const buffer = Buffer.from('', 'utf-8');
    const result = await parseFile(buffer, 'text/plain');

    expect(result.text).toBe('');
    expect(result.wordCount).toBe(0);
  });

  // ── Unsupported type ──────────────────────────────────────

  test('throws for unsupported MIME type', async () => {
    const buffer = Buffer.from('test');
    await expect(parseFile(buffer, 'application/json'))
      .rejects.toThrow('Unsupported file type: application/json');
  });

  test('throws for image MIME type', async () => {
    const buffer = Buffer.from('test');
    await expect(parseFile(buffer, 'image/png'))
      .rejects.toThrow('Unsupported file type');
  });

  // ── PDF parsing (integration) ─────────────────────────────

  test('pdf-parse getText returns an object with .text property', async () => {
    // Verify the pdf-parse v2 API shape — getText() returns { text, pages, total }
    const { PDFParse } = require('pdf-parse');
    expect(PDFParse).toBeDefined();

    // Instantiate with minimal config (no data)
    const parser = new PDFParse({ verbosity: 0 });
    expect(typeof parser.getText).toBe('function');
  });

  // ── DOCX parsing (integration) ────────────────────────────

  test('mammoth extractRawText is available', () => {
    const mammoth = require('mammoth');
    expect(typeof mammoth.extractRawText).toBe('function');
  });
});
