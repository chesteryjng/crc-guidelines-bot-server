// parsers/ocrImage.js
//
// Uses tesseract.js to OCR an image or scanned PDF page.
// "langs" is something like "eng" or "eng,chi_sim"

import Tesseract from 'tesseract.js';
import fs from 'fs';

export async function ocrImage(filePath, langs = 'eng') {
  const imgBuffer = fs.readFileSync(filePath);

  const { data } = await Tesseract.recognize(imgBuffer, langs, {
    logger: () => {
      // silence OCR progress logs in production
    }
  });

  const text = data && data.text ? data.text.trim() : '';
  return text;
}

