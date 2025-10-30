import Tesseract from 'tesseract.js';

export async function ocrImage(filePath, langs='eng') {
  const { data: { text } } = await Tesseract.recognize(filePath, langs, { logger: () => {} });
  return (text || '').trim();
}
