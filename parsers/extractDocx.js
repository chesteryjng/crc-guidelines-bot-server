import fs from 'fs';
import { parseDocx } from 'docx-parser';

export async function extractDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = await parseDocx(buffer);
  return (text || '').trim();
}
