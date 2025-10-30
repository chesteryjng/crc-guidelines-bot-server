import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import francPkg from "franc-min";
const franc = francPkg.franc || francPkg;

import { extractDocx } from "./parsers/extractDocx.js";
import { buildIndex, searchTop } from "./search/bm25.js";

// ------------------ Setup ------------------

const app = express();
app.use(cors());
app.use(express.json());

// env vars
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";
const LLM_API_URL = process.env.LLM_API_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

// paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageDir = path.join(__dirname, "storage");
const idxPath = path.join(storageDir, "index.json");
const bmPath = path.join(storageDir, "bm25.json");

if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

// ensure we have base index files
if (!fs.existsSync(idxPath)) {
  fs.writeFileSync(idxPath, JSON.stringify({ docs: [], chunks: [] }, null, 2));
}
if (!fs.existsSync(bmPath)) {
  fs.writeFileSync(bmPath, JSON.stringify(buildIndex([]), null, 2));
}

// multer disk storage for uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: function (_, __, cb) {
      cb(null, storageDir);
    },
    filename: function (_, file, cb) {
      // keep original extension
      const ext = path.extname(file.originalname);
      cb(null, uuidv4() + ext);
    },
  }),
});

// ------------------ Helpers ------------------

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(idxPath, "utf8"));
  } catch {
    return { docs: [], chunks: [] };
  }
}

function saveIndex(indexObj) {
  fs.writeFileSync(idxPath, JSON.stringify(indexObj, null, 2), "utf8");
}

function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
}

// Extract text from PDF (text layer only)
async function extractFromPdf(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(dataBuffer).catch(() => null);
  if (!parsed || !parsed.text) return "";
  return parsed.text.trim();
}

// Basic chunking helper
function chunkTextToPassages(text, sourceId, maxLen = 800) {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  const out = [];
  let buf = [];

  for (const w of words) {
    buf.push(w);
    const guessLang = franc(buf.join(" "));
    if (buf.join(" ").length > maxLen) {
      out.push(buf.join(" "));
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join(" "));

  return out.map((passage) => ({
    id: uuidv4(),
    sourceId,
    text: passage,
  }));
}

// ------------------ Healthcheck ------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    storageDir,
    LLM: !!LLM_API_KEY,
  });
});

// ------------------ Admin: Upload Guideline ------------------
//
// Frontend calls this with multipart/form-data containing:
// - title
// - langs (comma-separated, e.g. "eng" or "eng,chi_sim")
// - file upload ('docFile')
//
// We'll:
// 1. Save uploaded file into /storage.
// 2. Extract text (pdf/docx only; OCR step removed here for reliability).
// 3. Chunk the text.
// 4. Append to index.json.
// 5. Rebuild bm25.json.
//
// Returns metadata so admin UI can refresh list.
//
app.post("/api/upload", upload.single("docFile"), async (req, res) => {
  try {
    const { title, langs } = req.body;
    const fileInfo = req.file;

    if (!fileInfo) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Missing title" });
    }

    const sourceId = uuidv4();
    const originalName = fileInfo.originalname;
    const storedPath = fileInfo.path;
    const ext = path.extname(originalName).toLowerCase();

    // Extract text
    let textContent = "";

    if (ext === ".pdf") {
      textContent = (await extractFromPdf(storedPath)) || "";
    } else if (ext === ".docx") {
      textContent = (await extractDocx(storedPath)) || "";
    } else {
      // For simplicity we're not OCRing images here in this version.
      // If you had OCR before and you want it, we can re-add it,
      // but right now we'll just say "unsupported".
      return res
        .status(400)
        .json({ error: "Unsupported file type for text extraction" });
    }

    if (!textContent.trim()) {
      return res
        .status(400)
        .json({ error: "Could not extract text from this file" });
    }

    // Chunk the guideline
    const passages = chunkTextToPassages(textContent, sourceId);

    // Update index
    const idx = loadIndex();
    idx.docs.push({
      sourceId,
      title: title.trim(),
      filename: originalName,
      uploadedAt: new Date().toISOString(),
      lang: langs || "",
      chunks: passages.length,
    });
    idx.chunks.push(...passages);
    saveIndex(idx);

    // Rebuild BM25
    rebuildBm25AndSave(idx.chunks);

    return res.json({
      ok: true,
      sourceId,
      title: title.trim(),
      chunks: passages.length,
      langGuess: franc(textContent) || "",
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ error: "Upload failed on server" });
  }
});

// ------------------ Admin: List Current Guidelines ------------------

app.get("/api/sources", (req, res) => {
  try {
    const idx = loadIndex();
    return res.json(idx.docs || []);
  } catch (err) {
    console.error("SOURCES ERROR:", err);
    return res.status(500).json({ error: "Failed to read index" });
  }
});

// ------------------ Admin: Delete a Guideline ------------------
//
// DELETE /api/source/:id  (header: x-admin-secret must match ADMIN_SECRET)
//
// Steps:
// 1. Remove that doc entry from idx.docs
// 2. Remove all chunks with that sourceId
// 3. Save index
// 4. Rebuild BM25
//
app.delete("/api/source/:id", (req, res) => {
  try {
    const givenSecret = req.header("x-admin-secret");
    if (!givenSecret || givenSecret !== ADMIN_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;
    const idx = loadIndex();

    const beforeDocs = idx.docs.length;
    const beforeChunks = idx.chunks.length;

    idx.docs = idx.docs.filter((d) => d.sourceId !== id);
    idx.chunks = idx.chunks.filter((c) => c.sourceId !== id);

    const afterDocs = idx.docs.length;
    const afterChunks = idx.chunks.length;

    saveIndex(idx);
    rebuildBm25AndSave(idx.chunks);

    return res.json({
      ok: true,
      removedDocs: beforeDocs - afterDocs,
      removedChunks: beforeChunks - afterChunks,
    });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    return res.status(500).json({ error: "Delete failed on server" });
  }
});

// ------------------ DeepSeek Proxy (hides API key) ------------------
//
// The frontend/backend never calls DeepSeek directly.
// Only we call this route (from /api/ask).
// This keeps your LLM_API_KEY secret.
//
app.post("/api/deepseek-proxy", async (req, res) => {
  try {
    const { prompt, max_tokens = 512, temperature = 0.2 } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    if (!LLM_API_URL || !LLM_API_KEY) {
      return res.status(500).json({
        error: "Server missing DeepSeek credentials",
      });
    }

    const resp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // This shape assumes DeepSeek is OpenAI-compatible.
        // If DeepSeek's docs differ, adjust here.
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
      }),
    });

    const data = await resp.json().catch(() => null);
    return res.status(resp.status).json(data);
  } catch (err) {
    console.error("DeepSeek proxy error:", err);
    return res.status(500).json({ error: "Proxy failure" });
  }
});

// ------------------ RAG Ask ------------------
//
// 1. Find top relevant chunks from local BM25 index.
// 2. Build a strict, guideline-grounded prompt.
// 3. Send to DeepSeek via /api/deepseek-proxy for generation.
// 4. Return that answer to whoever asked.
//
// Frontend chatbot calls POST /api/ask { query: "..." }
//
app.post("/api/ask", async (req, res) => {
  const fallback =
    "Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.";
  try {
    const { query } = req.body || {};
    if (!query?.trim()) {
      return res.json({ answer: fallback });
    }

    // Load indices
    const idx = loadIndex();
    if (!idx.chunks.length) {
      return res.json({ answer: fallback });
    }

    let bm25Model;
    try {
      bm25Model = JSON.parse(fs.readFileSync(bmPath, "utf8"));
    } catch (err) {
      console.error("bm25 read error:", err);
      return res.json({ answer: fallback });
    }

    // Retrieve top 5 passages
    const hits = searchTop(bm25Model, query, 5);
    if (!hits.length || hits[0].score < 0.5) {
      return res.json({ answer: fallback });
    }

    // Summarize evidence
    const evidenceBlock = hits
      .map((hit, i) => {
        const parent = idx.docs.find((d) => d.sourceId === hit.sourceId);
        const title = parent?.title || "Guideline";
        const snippet = hit.text.replace(/\s+/g, " ").trim();
        return `(${i + 1}) [${title}] ${snippet}`;
      })
      .join("\n\n");

    // Construct safety-aware medical prompt
    const prompt = `
You are a colorectal cancer clinical information assistant.
Use ONLY the "Guideline evidence" below.
If the evidence does not clearly answer, reply exactly with:
"${fallback}"

User question:
"${query}"

Guideline evidence:
${evidenceBlock}

Give a concise, clinically responsible answer using only the evidence.
`.trim();

    // Call our own proxy (which calls DeepSeek securely)
    const proxyURL = `${req.protocol}://${req.get("host")}/api/deepseek-proxy`;
    const llmResp = await fetch(proxyURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        max_tokens: 512,
        temperature: 0.2,
      }),
    });

    if (!llmResp.ok) {
      console.error("Proxy DeepSeek error:", llmResp.status);
      return res.json({ answer: fallback });
    }

    const llmData = await llmResp.json().catch(() => null);

    // This shape assumes an OpenAI-like response:
    // { choices: [ { message: { content: "..." } } ] }
    const finalAnswer =
      llmData?.choices?.[0]?.message?.content?.trim?.() ||
      llmData?.text?.trim?.() || // fallback for alt schema
      fallback;

    return res.json({ answer: finalAnswer });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.status(500).json({ answer: fallback });
  }
});

// ------------------ Listen ------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Storage directory: ${storageDir}`);
});

