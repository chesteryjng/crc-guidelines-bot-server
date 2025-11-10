// server.js — CRC Guidelines Bot (Render)
// - Public chat: POST /api/ask
// - Health:      GET  /api/health
// - Status:      GET  /status            <-- added for frontend status ping
// - Upload:      POST /api/upload        <-- now REQUIRES x-admin-secret
// - List:        GET  /api/sources
// - Delete:      DELETE /api/source/:id  (requires x-admin-secret)
// - LLM proxy:   POST /api/llm-proxy
//
// Live updates: uploads/deletes rebuild BM25 immediately (shared across users)

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
import { ocrImage } from "./parsers/ocrImage.js";
import { buildIndex, searchTop } from "./search/bm25.js";

const app = express();

// CORS: permissive (works from GitHub Pages). Tighten later if you wish.
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ------------------ Env ------------------
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";

const LLM_API_URL = process.env.LLM_API_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL   = process.env.LLM_MODEL   || "";

// ------------------ Storage paths ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const storageDir = path.join(__dirname, "storage");
const idxPath = path.join(storageDir, "index.json");
const bmPath  = path.join(storageDir, "bm25.json");

if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
if (!fs.existsSync(idxPath)) {
  fs.writeFileSync(idxPath, JSON.stringify({ docs: [], chunks: [] }, null, 2), "utf8");
}
if (!fs.existsSync(bmPath)) {
  fs.writeFileSync(bmPath, JSON.stringify(buildIndex([]), null, 2), "utf8");
}

// ------------------ Helpers ------------------
function loadIndex() {
  try { return JSON.parse(fs.readFileSync(idxPath, "utf8")); }
  catch { return { docs: [], chunks: [] }; }
}
function saveIndex(indexObj) {
  fs.writeFileSync(idxPath, JSON.stringify(indexObj, null, 2), "utf8");
}
function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
}

async function extractFromPdf(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(dataBuffer).catch(() => null);
  if (!parsed || !parsed.text) return "";
  return parsed.text.trim();
}

// Split into ~800-char chunks by whitespace. (Works fine for English;
// Chinese/Japanese become longer runs but still indexable.)
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
  return out.map(passage => ({ id: uuidv4(), sourceId, text: passage }));
}

// ------------------ Rebuild BM25 on boot ------------------
(function forceBm25RebuildOnBoot() {
  try {
    const idx = loadIndex();
    const model = buildIndex(idx.chunks || []);
    fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
    console.log("[BOOT] BM25 rebuilt from current index.json");
    console.log("[BOOT] docs:", (idx.docs || []).length, "chunks:", (idx.chunks || []).length);
  } catch (err) {
    console.error("[BOOT] Failed to rebuild BM25 on startup:", err);
  }
})();

// ------------------ Health / Status ------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    storageDir,
    llmConfigured: !!(LLM_API_URL && LLM_API_KEY && LLM_MODEL),
  });
});

// Added: simple status used by frontend to show KB version / doc count.
app.get("/status", (_req, res) => {
  try {
    const idx = loadIndex();
    const docCount = (idx.docs || []).length;
    const chunks   = (idx.chunks || []).length;
    // naive version = total writes to index file length; we don’t track directly.
    // Instead, expose last modified time as a proxy "version stamp".
    const stat = fs.statSync(idxPath);
    const lastUpdated = stat.mtime.toISOString();
    res.json({ version: stat.mtimeMs | 0, lastUpdated, docCount, chunks });
  } catch (e) {
    res.status(200).json({ version: 0, lastUpdated: null, docCount: 0, chunks: 0 });
  }
});

// ------------------ Multer ------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, storageDir),
    filename: (_req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
  }),
}).fields([
  { name: "docFile",  maxCount: 1 },
  { name: "file",     maxCount: 1 },
  { name: "document", maxCount: 1 },
]);

// ------------------ Upload (requires admin secret) ------------------
// POST /api/upload  (multipart: title, langs, docFile|file|document)
// Header: x-admin-secret: <ADMIN_SECRET>
app.post("/api/upload", (req, res) => {
  upload(req, res, async (err) => {
    try {
      if (err) {
        console.error("MULTER ERROR:", err);
        return res.status(400).json({ error: "Upload failed (multer)", detail: String(err) });
      }

      const givenSecret = req.header("x-admin-secret");
      if (!givenSecret || givenSecret !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Forbidden (admin secret missing/invalid)" });
      }

      const { title, langs } = req.body || {};
      const fileInfo =
        (req.files?.docFile?.[0]) ||
        (req.files?.file?.[0]) ||
        (req.files?.document?.[0]) ||
        null;

      if (!fileInfo) return res.status(400).json({ error: "No file received by server" });
      if (!title?.trim()) return res.status(400).json({ error: "Missing title" });

      const sourceId    = uuidv4();
      const original    = fileInfo.originalname;
      const storedPath  = fileInfo.path;
      const ext         = path.extname(original).toLowerCase();

      let textContent = "";
      if (ext === ".pdf") {
        textContent = (await extractFromPdf(storedPath)) || "";
      } else if (ext === ".docx") {
        textContent = (await extractDocx(storedPath)) || "";
      } else if ([".png",".jpg",".jpeg",".tif",".tiff"].includes(ext)) {
        textContent = (await ocrImage(storedPath, langs)) || "";
      } else {
        return res.status(400).json({
          error: "Unsupported file type. Supported: pdf, docx, png, jpg, jpeg, tif, tiff",
          receivedExt: ext,
        });
      }

      if (!textContent.trim()) {
        return res.status(400).json({
          error: "Could not extract text from this file (empty result). " +
                 "For scanned PDFs, embedded PDF OCR is not implemented."
        });
      }

      const passages = chunkTextToPassages(textContent, sourceId);

      const idx = loadIndex();
      idx.docs.push({
        sourceId,
        title: title.trim(),
        filename: original,
        uploadedAt: new Date().toISOString(),
        lang: langs || "",
        chunks: passages.length,
      });
      idx.chunks.push(...passages);
      saveIndex(idx);
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
      return res.status(500).json({ error: "Upload failed on server", detail: String(e) });
    }
  });
});

// ------------------ List Guidelines ------------------
app.get("/api/sources", (_req, res) => {
  try {
    const idx = loadIndex();
    return res.json(idx.docs || []);
  } catch (err) {
    console.error("SOURCES ERROR:", err);
    return res.status(500).json({ error: "Failed to read index" });
  }
});

// ------------------ Delete Guideline (requires admin secret) ------------------
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

    idx.docs   = idx.docs.filter((d) => d.sourceId !== id);
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

// ------------------ LLM Proxy ------------------
app.post("/api/llm-proxy", async (req, res) => {
  try {
    const { prompt, max_tokens = 512, temperature = 0.2 } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    if (!LLM_API_URL || !LLM_API_KEY || !LLM_MODEL) {
      console.error("[LLM] Missing LLM_API_URL / LLM_API_KEY / LLM_MODEL");
      return res.status(500).json({
        error: "Server LLM config incomplete",
        have_URL: !!LLM_API_URL,
        have_KEY: !!LLM_API_KEY,
        have_MODEL: !!LLM_MODEL,
      });
    }

    const upstreamResp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
      }),
    });

    const rawText = await upstreamResp.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

    if (!upstreamResp.ok) {
      console.error("[LLM] Upstream error:", upstreamResp.status, JSON.stringify(data).slice(0, 300));
      return res.status(upstreamResp.status).json({
        error: "Upstream LLM request failed",
        status: upstreamResp.status,
        data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[LLM] Proxy failure:", err);
    return res.status(500).json({ error: "Proxy failure", detail: String(err) });
  }
});

// ------------------ RAG Ask ------------------
app.post("/api/ask", async (req, res) => {
  const fallback =
    "Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.";

  try {
    const { query } = req.body || {};
    if (!query?.trim()) return res.json({ answer: fallback });

    // Load index
    const idx = loadIndex();
    if (!idx.chunks.length) {
      console.log("[ASK] No chunks in index.json at all.");
      return res.json({ answer: fallback });
    }

    // Load BM25 model
    let bm25Model;
    try { bm25Model = JSON.parse(fs.readFileSync(bmPath, "utf8")); }
    catch (err) {
      console.error("[ASK] bm25 read error:", err);
      return res.json({ answer: fallback });
    }

    // Retrieve top hits
    const hits = searchTop(bm25Model, query, 5);
    if (!hits.length) {
      console.log("[ASK] No hits returned for query:", query);
      return res.json({ answer: fallback });
    }

    console.log("[ASK] Query:", query);
    hits.forEach((h, i) => {
      console.log(`   #${i + 1} score=${h.score?.toFixed?.(3)} src=${h.sourceId} text=${(h.text||"").slice(0,160).replace(/\s+/g," ")}...`);
    });

    const bestScore = hits[0].score ?? 0;
    if (bestScore < 0.2) {
      console.log("[ASK] Best score below threshold:", bestScore);
      return res.json({ answer: fallback });
    }

    const evidenceBlock = hits.map((hit, i) => {
      const parentDoc = idx.docs.find((d) => d.sourceId === hit.sourceId);
      const title = parentDoc?.title || "Guideline";
      const snippet = (hit.text || "").replace(/\s+/g, " ").trim();
      return `(${i + 1}) [${title}] ${snippet}`;
    }).join("\n\n");

    const prompt = `
You are a colorectal cancer clinical information assistant.
You MUST follow these rules:
- Only answer using the "Guideline evidence" below.
- If the evidence does not clearly answer, reply exactly with:
"${fallback}"
- Do not invent or guess treatments, doses, or recommendations that are not explicitly stated.

User question:
"${query}"

Guideline evidence:
${evidenceBlock}

Provide the best possible answer in clear, clinically responsible language.
`.trim();

    // Call local LLM proxy (same host)
    const proxyURL = `${req.protocol}://${req.get("host")}/api/llm-proxy`;
    const llmResp = await fetch(proxyURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, max_tokens: 512, temperature: 0.2 }),
    });

    if (!llmResp.ok) {
      console.error("[ASK] Proxy LLM error:", llmResp.status);
      return res.json({ answer: fallback });
    }

    const llmData = await llmResp.json().catch(() => null);
    console.log("[ASK] LLM raw:", JSON.stringify(llmData).slice(0, 2000));

    let answerText = null;
    if (llmData && Array.isArray(llmData.choices) && llmData.choices.length > 0) {
      if (llmData.choices[0].message?.content) answerText = llmData.choices[0].message.content;
      else if (llmData.choices[0].text)        answerText = llmData.choices[0].text;
    }
    if (!answerText && llmData?.output) answerText = llmData.output;
    if (!answerText && llmData?.answer) answerText = llmData.answer;
    if (answerText && typeof answerText === "string") answerText = answerText.trim();

    if (!answerText) {
      console.warn("[ASK] Unable to extract LLM answer, using fallback.");
      return res.json({ answer: fallback });
    }

    return res.json({ answer: answerText });
  } catch (err) {
    console.error("[ASK] Unhandled error:", err);
    return res.status(500).json({ answer: fallback });
  }
});

// ------------------ Start ------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Storage directory: ${storageDir}`);
});
