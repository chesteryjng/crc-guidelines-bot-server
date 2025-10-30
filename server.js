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

// ------------------ Setup ------------------

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";

// Generic LLM config (provider-agnostic)
const LLM_API_URL = process.env.LLM_API_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "";

// Resolve paths for storage
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageDir = path.join(__dirname, "storage");
const idxPath = path.join(storageDir, "index.json");
const bmPath = path.join(storageDir, "bm25.json");

// Ensure storage folder exists
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

// Extract text from PDFs (text layer only)
async function extractFromPdf(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(dataBuffer).catch(() => null);
  if (!parsed || !parsed.text) return "";
  return parsed.text.trim();
}

// Chunk text into ~800 char passages
function chunkTextToPassages(text, sourceId, maxLen = 800) {
  // whitespace splitting strategy:
  // ok for English, Chinese becomes long runs, but still indexable
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

// --------------- Rebuild BM25 on boot ---------------
//
// On service start, ensure bm25.json is in sync with index.json.
// This prevents "stale bm25" issues after code changes or redeploy.

(function forceBm25RebuildOnBoot() {
  try {
    const idx = loadIndex();
    const model = buildIndex(idx.chunks || []);
    fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
    console.log("[BOOT] BM25 rebuilt from current index.json");
    console.log(
      "[BOOT] docs:",
      (idx.docs || []).length,
      "chunks:",
      (idx.chunks || []).length
    );
  } catch (err) {
    console.error("[BOOT] Failed to rebuild BM25 on startup:", err);
  }
})();

// ------------------ Healthcheck ------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    storageDir,
    llmConfigured: !!(LLM_API_URL && LLM_API_KEY && LLM_MODEL),
  });
});

// ------------------ Multer config ------------------
//
// We accept docFile/file/document as possible field names.

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

// ------------------ Upload Guideline ------------------
//
// POST /api/upload
// multipart/form-data: title, langs, file (pdf/docx/png/jpg/tif/...)
// - PDF: we read embedded text only (no OCR inside PDF pages of pure images)
// - DOCX: we parse text
// - Images: we run OCR using Tesseract via ocrImage()

app.post("/api/upload", (req, res) => {
  multiFieldUpload(req, res, async (err) => {
    try {
      if (err) {
        console.error("MULTER ERROR:", err);
        return res.status(400).json({
          error: "Upload failed (multer)",
          detail: String(err),
        });
      }

      const { title, langs } = req.body || {};

      const fileInfo =
        (req.files && req.files.docFile && req.files.docFile[0]) ||
        (req.files && req.files.file && req.files.file[0]) ||
        (req.files && req.files.document && req.files.document[0]) ||
        null;

      if (!fileInfo) {
        return res.status(400).json({
          error: "No file received by server",
          body: req.body || {},
        });
      }

      if (!title || !title.trim()) {
        return res.status(400).json({ error: "Missing title" });
      }

      const sourceId = uuidv4();
      const originalName = fileInfo.originalname;
      const storedPath = fileInfo.path;
      const ext = path.extname(originalName).toLowerCase();

      let textContent = "";

      if (ext === ".pdf") {
        // text layer from PDF
        textContent = (await extractFromPdf(storedPath)) || "";
      } else if (ext === ".docx") {
        // parse DOCX
        textContent = (await extractDocx(storedPath)) || "";
      } else if (
        ext === ".png" ||
        ext === ".jpg" ||
        ext === ".jpeg" ||
        ext === ".tif" ||
        ext === ".tiff"
      ) {
        // OCR on images
        textContent = (await ocrImage(storedPath, langs)) || "";
      } else {
        return res.status(400).json({
          error:
            "Unsupported file type for extraction. Supported: pdf, docx, png, jpg, jpeg, tif, tiff",
          receivedExt: ext,
        });
      }

      if (!textContent.trim()) {
        return res.status(400).json({
          error:
            "Could not extract text from this file (empty result). " +
            "If this is a scanned PDF, PDF OCR for embedded images is not implemented yet.",
        });
      }

      // Chunk and update index
      const passages = chunkTextToPassages(textContent, sourceId);

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
      return res
        .status(500)
        .json({ error: "Upload failed on server", detail: String(e) });
    }
  });
});

// ------------------ List Guidelines ------------------
//
// GET /api/sources
// Used in the admin dashboard to show which guidelines are loaded

app.get("/api/sources", (req, res) => {
  try {
    const idx = loadIndex();
    return res.json(idx.docs || []);
  } catch (err) {
    console.error("SOURCES ERROR:", err);
    return res.status(500).json({ error: "Failed to read index" });
  }
});

// ------------------ Delete Guideline ------------------
//
// DELETE /api/source/:id
// Requires header x-admin-secret == ADMIN_SECRET
// Removes that doc + its chunks, then rebuilds BM25

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

// ------------------ Generic LLM Proxy ------------------
//
// POST /api/llm-proxy
// Body: { prompt, max_tokens?, temperature? }
//
// This hides your LLM API key from the browser. It forwards the chat
// completion request to the provider defined by environment variables.

app.post("/api/llm-proxy", async (req, res) => {
  try {
    const { prompt, max_tokens = 512, temperature = 0.2 } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

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
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    if (!upstreamResp.ok) {
      console.error(
        "[LLM] Upstream error:",
        upstreamResp.status,
        JSON.stringify(data).slice(0, 300)
      );
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
//
// POST /api/ask
// Body: { query: "..." }
//
// Flow:
// 1. Retrieve top 5 matching passages from BM25
// 2. Build a strict evidence-based prompt
// 3. Send that to /api/llm-proxy
// 4. Extract the model answer (safely, with logging)

app.post("/api/ask", async (req, res) => {
  const fallback =
    "Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.";

  try {
    const { query } = req.body || {};
    if (!query?.trim()) {
      return res.json({ answer: fallback });
    }

    // Load index.json
    const idx = loadIndex();
    if (!idx.chunks.length) {
      console.log("[ASK] No chunks in index.json at all.");
      return res.json({ answer: fallback });
    }

    // Load bm25.json
    let bm25Model;
    try {
      bm25Model = JSON.parse(fs.readFileSync(bmPath, "utf8"));
    } catch (err) {
      console.error("[ASK] bm25 read error:", err);
      return res.json({ answer: fallback });
    }

    // Retrieve top 5 hits
    const hits = searchTop(bm25Model, query, 5);

    if (!hits.length) {
      console.log("[ASK] No hits returned for query:", query);
      return res.json({ answer: fallback });
    }

    // Debug hits
    console.log("[ASK] Query:", query);
    console.log("[ASK] Top hits (score, sourceId, snippet):");
    hits.forEach((h, i) => {
      console.log(
        `   #${i + 1} score=${h.score?.toFixed?.(3)} src=${h.sourceId} text=${(h.text || "")
          .slice(0, 160)
          .replace(/\s+/g, " ")}...`
      );
    });

    // Safety threshold — currently irrelevant because your scores are huge (>6),
    // but we keep it in place to avoid hallucinations for totally unrelated queries:
    const bestScore = hits[0].score ?? 0;
    if (bestScore < 0.2) {
      console.log("[ASK] Best score below threshold:", bestScore);
      return res.json({ answer: fallback });
    }

    // Build evidence text
    const evidenceBlock = hits
      .map((hit, i) => {
        const parentDoc = idx.docs.find((d) => d.sourceId === hit.sourceId);
        const title = parentDoc?.title || "Guideline";
        const snippet = (hit.text || "").replace(/\s+/g, " ").trim();
        return `(${i + 1}) [${title}] ${snippet}`;
      })
      .join("\n\n");

    // Build the strict prompt
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

    // Call our local LLM proxy (which in turn calls Groq/OpenAI/etc)
    const proxyURL = `${req.protocol}://${req.get("host")}/api/llm-proxy`;

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
      console.error("[ASK] Proxy LLM error:", llmResp.status);
      return res.json({ answer: fallback });
    }

    const llmData = await llmResp.json().catch(() => null);

    // Log raw LLM output for debugging model format
    console.log("[ASK] LLM raw:", JSON.stringify(llmData).slice(0, 2000));

    // Try to extract an answer from several common response shapes
    let answerText = null;

    // Typical OpenAI / Groq chat shape:
    if (
      llmData &&
      Array.isArray(llmData.choices) &&
      llmData.choices.length > 0
    ) {
      if (llmData.choices[0].message?.content) {
        answerText = llmData.choices[0].message.content;
      } else if (llmData.choices[0].text) {
        // sometimes providers return .text
        answerText = llmData.choices[0].text;
      }
    }

    // Other fallback keys some providers use:
    if (!answerText && llmData?.output) {
      answerText = llmData.output;
    }
    if (!answerText && llmData?.answer) {
      answerText = llmData.answer;
    }

    // Clean up
    if (answerText && typeof answerText === "string") {
      answerText = answerText.trim();
    }

    // If we *still* couldn't extract anything, use fallback.
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

// ------------------ Start Server ------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Storage directory: ${storageDir}`);
});
