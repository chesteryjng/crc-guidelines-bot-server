// parsers/extractDocx.js
import mammoth from 'mammoth';
import fs from 'fs';

/**
 * Extracts raw text content from a .docx or .doc file using mammoth.
 * Returns plain UTF-8 text.
 */
export async function extractDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  // result.value is the raw text from the Word doc
  return (result.value || '').trim();
}



