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

// Environment variables
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";
const LLM_API_URL = process.env.LLM_API_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

// Resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageDir = path.join(__dirname, "storage");
const idxPath = path.join(storageDir, "index.json");
const bmPath = path.join(storageDir, "bm25.json");

// Ensure storage exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Ensure base index + bm25 exist
if (!fs.existsSync(idxPath)) {
  fs.writeFileSync(
    idxPath,
    JSON.stringify({ docs: [], chunks: [] }, null, 2),
    "utf8"
  );
}
if (!fs.existsSync(bmPath)) {
  fs.writeFileSync(bmPath, JSON.stringify(buildIndex([]), null, 2), "utf8");
}

// ------------------ Helpers ------------------

// Load current index.json
function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(idxPath, "utf8"));
  } catch {
    return { docs: [], chunks: [] };
  }
}

// Save updated index.json
function saveIndex(indexObj) {
  fs.writeFileSync(idxPath, JSON.stringify(indexObj, null, 2), "utf8");
}

// Rebuild BM25 model anytime index changes
function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
}

// Extract text from PDFs (no OCR, just embedded text layer)
async function extractFromPdf(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(dataBuffer).catch(() => null);
  if (!parsed || !parsed.text) return "";
  return parsed.text.trim();
}

// Chunk long text into smaller passages
function chunkTextToPassages(text, sourceId, maxLen = 800) {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  const out = [];
  let buf = [];

  for (const w of words) {
    buf.push(w);
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

// ------------------ Multer config ------------------
//
// We want to accept file uploads from the admin UI, but we’ve seen
// that sometimes the <input name="..."> differs ("docFile", "file", "document").
// We'll allow multiple names.
//
// We'll store files in /storage with random UUID names.

const multiFieldUpload = multer({
  storage: multer.diskStorage({
    destination: function (_, __, cb) {
      cb(null, storageDir);
    },
    filename: function (_, file, cb) {
      const ext = path.extname(file.originalname);
      cb(null, uuidv4() + ext);
    },
  }),
}).fields([
  { name: "docFile", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "document", maxCount: 1 },
]);

// ------------------ Admin: Upload Guideline ------------------
//
// POST /api/upload
// Form fields expected from admin page:
//   title: string
//   langs: string (e.g. "eng" or "eng,chi_sim")
//   docFile/file/document: uploaded .pdf or .docx
//
// Steps:
// 1. Save file
// 2. Extract text (PDF or DOCX only in this version)
// 3. Chunk text
// 4. Append to index.json
// 5. Rebuild bm25.json

app.post("/api/upload", (req, res) => {
  multiFieldUpload(req, res, async (err) => {
    try {
      if (err) {
        console.error("MULTER ERROR:", err);
        return res
          .status(400)
          .json({ error: "Upload failed (multer)", detail: String(err) });
      }

      const { title, langs } = req.body || {};

      // Which file field did we get?
      const fileInfo =
        (req.files && req.files.docFile && req.files.docFile[0]) ||
        (req.files && req.files.file && req.files.file[0]) ||
        (req.files && req.files.document && req.files.document[0]) ||
        null;

      if (!fileInfo) {
        return res
          .status(400)
          .json({ error: "No file received by server", body: req.body || {} });
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
        // We disabled OCR for now to keep things stable.
        return res.status(400).json({
          error: "Unsupported file type for text extraction (only .pdf / .docx now)",
          receivedExt: ext,
        });
      }

      if (!textContent.trim()) {
        return res.status(400).json({
          error: "Could not extract text from file (empty text)",
        });
      }

      // Chunk up the extracted text into passages
      const passages = chunkTextToPassages(textContent, sourceId);

      // Update index.json
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

      // Rebuild BM25 search index
      rebuildBm25AndSave(idx.chunks);

      return res.json({
        ok: true,
        sourceId,
        title: title.trim(),
        chunks: passages.length,
        langGuess: franc(textContent) || "",
      });
    } catch (e) {
      console.error("UPLOAD HANDLER ERROR:", e);
      return res.status(500).json({ error: "Upload failed on server" });
    }
  });
});

// ------------------ Admin: List current guidelines ------------------
//
// GET /api/sources
// Returns metadata of all uploaded guideline documents.

app.get("/api/sources", (req, res) => {
  try {
    const idx = loadIndex();
    return res.json(idx.docs || []);
  } catch (err) {
    console.error("SOURCES ERROR:", err);
    return res.status(500).json({ error: "Failed to read index" });
  }
});

// ------------------ Admin: Delete a guideline ------------------
//
// DELETE /api/source/:id
// Header: x-admin-secret: must match ADMIN_SECRET
//
// Steps:
// 1. Remove doc entry from idx.docs
// 2. Remove its chunks from idx.chunks
// 3. Save and rebuild BM25

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

// ------------------ DeepSeek Proxy ------------------
//
// POST /api/deepseek-proxy
// Body: { prompt, max_tokens?, temperature? }
//
// This route calls DeepSeek using your API key, which lives in
// environment variable LLM_API_KEY. The frontend (and normal
// clients) never see that key.

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

    // The body here assumes DeepSeek is OpenAI-chat compatible.
    // If DeepSeek uses a different shape, adjust here.
    const resp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
// POST /api/ask
// Body: { query: "..." }
//
// 1. Retrieve top chunks from BM25.
// 2. Build a strict prompt that forces answers ONLY from guideline evidence.
// 3. Send that prompt through /api/deepseek-proxy so your key is hidden.
// 4. Return DeepSeek's final answer.

app.post("/api/ask", async (req, res) => {
  const fallback =
    "Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.";

  try {
    const { query } = req.body || {};
    if (!query?.trim()) {
      return res.json({ answer: fallback });
    }

    // Load index
    const idx = loadIndex();
    if (!idx.chunks.length) {
      return res.json({ answer: fallback });
    }

    // Load BM25 model
    let bm25Model;
    try {
      bm25Model = JSON.parse(fs.readFileSync(bmPath, "utf8"));
    } catch (err) {
      console.error("bm25 read error:", err);
      return res.json({ answer: fallback });
    }

    // Retrieve top 5 hits
    const hits = searchTop(bm25Model, query, 5);
    if (!hits.length || hits[0].score < 0.5) {
      return res.json({ answer: fallback });
    }

    // Build evidence block with short context + title
    const evidenceBlock = hits
      .map((hit, i) => {
        const parentDoc = idx.docs.find((d) => d.sourceId === hit.sourceId);
        const title = parentDoc?.title || "Guideline";
        const snippet = hit.text.replace(/\s+/g, " ").trim();
        return `(${i + 1}) [${title}] ${snippet}`;
      })
      .join("\n\n");

    // Build DeepSeek prompt with safety instructions
    const prompt = `
You are a colorectal cancer clinical information assistant.
You MUST follow these rules:
- Only answer using the "Guideline evidence" below.
- If the evidence does not clearly answer, reply exactly with:
"${fallback}"
- Do not invent or guess treatments, doses, or recommendations
  that are not explicitly stated.

User question:
"${query}"

Guideline evidence:
${evidenceBlock}

Provide the best possible answer in clear, clinically responsible language.
`.trim();

    // Call our internal proxy so DeepSeek key stays hidden
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

    // We assume an OpenAI-style response:
    // { choices: [ { message: { content: "..." } } ] }
    const finalAnswer =
      llmData?.choices?.[0]?.message?.content?.trim?.() ||
      llmData?.text?.trim?.() ||
      fallback;

    return res.json({ answer: finalAnswer });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.status(500).json({ answer: fallback });
  }
});

// ------------------ Start server ------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Storage directory: ${storageDir}`);
});

