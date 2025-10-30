import fs from 'fs';
import mammoth from 'mammoth';

export async function extractDocx(filePath) {
  // mammoth extracts text from .docx buffer
  const buffer = fs.readFileSync(filePath);

  const result = await mammoth.extractRawText({ buffer });
  // result.value is the extracted plain text
  const text = (result && result.value) ? result.value : '';

  return text.trim();
}

