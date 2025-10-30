import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { extractDocx } from "./parsers/extractDocx.js";
import { buildIndex, searchTop } from "./search/bm25.js";
import francPkg from "franc-min";
const franc = francPkg.franc || francPkg;

const app = express();
app.use(cors());
app.use(express.json());

// ----- ENVIRONMENT VARIABLES -----
const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";
const LLM_API_URL = process.env.LLM_API_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

// ----- STORAGE PATHS -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageDir = path.join(__dirname, "storage");
const idxPath = path.join(storageDir, "index.json");
const bmPath = path.join(storageDir, "bm25.json");
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir);

// ---------------- HELPERS ----------------
function loadIndex() {
  if (!fs.existsSync(idxPath)) return { docs: [], chunks: [] };
  return JSON.parse(fs.readFileSync(idxPath, "utf8"));
}
function saveIndex(data) {
  fs.writeFileSync(idxPath, JSON.stringify(data, null, 2), "utf8");
}
function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), "utf8");
}

// ---------- HEALTH ----------
app.get("/api/health", (_, res) =>
  res.json({ ok: true, storageDir, LLM: !!LLM_API_KEY })
);

// ---------- ADMIN UPLOAD / DELETE / SOURCES ----------
// (keep your existing upload + delete code here – unchanged)

// ---------- DEEPSEEK PROXY (hides API key) ----------
app.post("/api/deepseek-proxy", async (req, res) => {
  try {
    const { prompt, max_tokens = 512, temperature = 0.2 } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    if (!LLM_API_URL || !LLM_API_KEY)
      return res.status(500).json({ error: "Server missing DeepSeek credentials" });

    const resp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat", // adjust if docs require a different model name
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
      }),
    });

    const data = await resp.json().catch(() => null);
    res.status(resp.status).json(data);
  } catch (err) {
    console.error("DeepSeek proxy error:", err);
    res.status(500).json({ error: "Proxy failure" });
  }
});

// ---------- RAG ASK ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { query } = req.body || {};
    const fallback =
      "Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.";

    if (!query?.trim()) return res.status(400).json({ answer: fallback });

    const idx = loadIndex();
    if (!idx.chunks.length) return res.json({ answer: fallback });
    const bm25Model = JSON.parse(fs.readFileSync(bmPath, "utf8"));
    const hits = searchTop(bm25Model, query, 5);
    if (!hits.length || hits[0].score < 0.5) return res.json({ answer: fallback });

    const evidence = hits
      .map((h, i) => {
        const d = idx.docs.find((x) => x.sourceId === h.sourceId);
        return `(${i + 1}) [${d?.title || "Guideline"}] ${h.text.replace(/\s+/g, " ")}`;
      })
      .join("\n\n");

    const prompt = `
You are a colorectal cancer clinical information assistant.
Only use the evidence below to answer.
If the evidence does not directly support an answer, respond:
"${fallback}"

User question: "${query}"

Guideline evidence:
${evidence}
`.trim();

    // --- Call your secure proxy instead of DeepSeek directly ---
    const proxyResp = await fetch(`${req.protocol}://${req.get("host")}/api/deepseek-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, max_tokens: 512, temperature: 0.2 }),
    });

    if (!proxyResp.ok) {
      console.error("Proxy error:", proxyResp.status);
      return res.json({ answer: fallback });
    }

    const proxyData = await proxyResp.json().catch(() => null);
    const answer =
      proxyData?.choices?.[0]?.message?.content?.trim?.() ||
      proxyData?.text?.trim?.() ||
      fallback;

    res.json({ answer });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(500).json({ answer: "Server error." });
  }
});

// ---------- START ----------
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}, storage at ${storageDir}`)
);
