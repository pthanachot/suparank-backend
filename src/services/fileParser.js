/**
 * Parse uploaded files (PDF, DOCX, TXT) into plain text.
 */

const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

const SUPPORTED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/**
 * Parse a file buffer into plain text.
 * @param {Buffer} buffer - File content
 * @param {string} mimetype - MIME type
 * @returns {Promise<{ text: string, wordCount: number }>}
 */
async function parseFile(buffer, mimetype) {
  let text = '';

  switch (mimetype) {
    case 'application/pdf': {
      const parser = new PDFParse({ verbosity: 0, data: buffer });
      const result = await parser.getText();
      text = result.text;
      break;
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      break;
    }
    case 'text/plain': {
      text = buffer.toString('utf-8');
      break;
    }
    default:
      throw new Error(`Unsupported file type: ${mimetype}. Supported: PDF, DOCX, TXT`);
  }

  // Clean up whitespace
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { text, wordCount };
}

module.exports = { parseFile, SUPPORTED_MIMES };
