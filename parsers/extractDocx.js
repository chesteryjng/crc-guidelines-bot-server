import mammoth from "mammoth";
import fs from "fs";

export async function extractDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || "").trim();
}



