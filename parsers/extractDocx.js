import fs from 'fs';
import mammoth from 'mammoth';

export async function extractDocx(filePath) {
  const buffer = fs.readFileSync(filePath);

  const result = await mammoth.extractRawText({ buffer });
  const text = (result && result.value) ? result.value : '';

  return text.trim();
}


