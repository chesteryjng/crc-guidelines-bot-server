// server.js
//
// Backend API for:
// - uploading guidelines (PDF/DOCX/image with OCR)
// - chunking + indexing
// - answering user questions from uploaded guidelines
// - listing & deleting guidelines
//
// Persistent data is kept in /storage (or Render's runtime dir).
// Deletion rebuilds the BM25 model so removed docs stop showing up.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { extractDocx } from './parsers/extractDocx.js';
import { ocrImage } from './parsers/ocrImage.js';
import { buildIndex, searchTop } from './search/bm25.js';
import { franc } from 'franc-min';

// --------------------------------------------------
// __dirname emulation for ES modules
// --------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// App config
// --------------------------------------------------
const app = express();
app.use(cors()); // allow cross-origin calls from GitHub Pages frontend
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

// storage paths
const storageRoot =
  process.env.STORAGE_DIR ||
  process.env.storageDir ||
  path.join(__dirname, 'storage');

const storageDir = path.resolve(storageRoot);
const uploadDir = path.join(storageDir, 'uploads');
const indexPath = path.join(storageDir, 'index.json');
const bmPath = path.join(storageDir, 'bm25.json');

// ensure dirs exist
fs.mkdirSync(uploadDir, { recursive: true });

// --------------------------------------------------
// index.json structure:
//
// {
//   "docs": [
//     {
//       "sourceId": "...",
//       "title": "...",
//       "filename": "...",
//       "lang": "...",
//       "uploadedAt": "ISO string"
//     }
//   ],
//   "chunks": [
//     { "id": "...", "sourceId": "...", "text": "..." }
//   ],
//   "builtAt": "ISO string"
// }
// --------------------------------------------------
function loadIndex() {
  if (fs.existsSync(indexPath)) {
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (err) {
      console.error('Error parsing index.json. Resetting.', err);
    }
  }
  return { docs: [], chunks: [], builtAt: null };
}

function saveIndex(idx) {
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
}

// Build BM25 model from chunks and write to bm25.json
function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), 'utf8');
}

// Multer for handling uploads
const upload = multer({ dest: uploadDir });

// --------------------------------------------------
// Extract text helpers
// --------------------------------------------------
async function extractFromPdf(filePath) {
  // First try text layer
  const data = await pdfParse(fs.readFileSync(filePath));
  const text = (data.text || '').trim();
  return text;
}

// chunk long text -> overlapping passages for search
function makeChunks(fullText, sourceId, size = 1200, overlap = 120) {
  const out = [];
  let i = 0;
  while (i < fullText.length) {
    const slice = fullText.slice(i, i + size);
    out.push({ id: uuidv4(), sourceId, text: slice });
    i += (size - overlap);
  }
  return out;
}

// --------------------------------------------------
// ROUTE: GET /api/health
// Simple sanity check
// --------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, storageDir });
});

// --------------------------------------------------
// ROUTE: POST /api/upload
//
// form-data:
//   secret = ADMIN_SECRET
//   title  = guideline title
//   langs  = "eng" or "eng,chi_sim" etc
//   file   = PDF / DOCX / JPG / PNG / TIFF
//
// Actions:
//   - extract text (try parse for pdf/docx, fallback OCR if scanned/IMG)
//   - detect language (franc-min)
//   - chunk text
//   - append to index.json
//   - rebuild bm25.json
// --------------------------------------------------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { secret, title, langs = 'eng' } = req.body || {};

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.file || !title) {
      return res.status(400).json({
        error: 'Missing file and/or title'
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const sourceId = uuidv4();
    let text = '';

    if (ext === '.pdf') {
      // try text layer
      text = (await extractFromPdf(req.file.path)) || '';
      // fallback OCR if empty
      if (!text.trim()) {
        text = await ocrImage(req.file.path, langs);
      }
    } else if (ext === '.doc' || ext === '.docx') {
      text = await extractDocx(req.file.path);
    } else if (
      ext === '.png' ||
      ext === '.jpg' ||
      ext === '.jpeg' ||
      ext === '.tif' ||
      ext === '.tiff'
    ) {
      text = await ocrImage(req.file.path, langs);
    } else {
      return res.status(415).json({
        error: `Unsupported file type: ${ext}`
      });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: 'No extractable text found (even after OCR).'
      });
    }

    const langGuess = franc(text.slice(0, 4000) || 'unknown');

    // chunk it
    const newChunks = makeChunks(text, sourceId);

    // merge into index
    const idx = loadIndex();
    idx.docs.push({
      sourceId,
      title,
      filename: req.file.originalname,
      lang: langGuess,
      uploadedAt: new Date().toISOString()
    });
    idx.chunks.push(...newChunks);
    idx.builtAt = new Date().toISOString();

    // rebuild BM25
    rebuildBm25AndSave(idx.chunks);

    // save index
    saveIndex(idx);

    return res.json({
      ok: true,
      sourceId,
      title,
      chunks: newChunks.length,
      langGuess
    });

  } catch (err) {
    console.error('UPLOAD ERROR:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// --------------------------------------------------
// ROUTE: POST /api/ask
//
// body JSON: { "query": "user question" }
//
// returns best chunk from loaded guidelines,
// or fallback advice if relevance is too weak.
// --------------------------------------------------
app.post('/api/ask', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const fallback =
      'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.';

    const idx = loadIndex();
    if (!idx.chunks.length) {
      return res.json({ answer: fallback });
    }

    if (!fs.existsSync(bmPath)) {
      return res.json({ answer: fallback });
    }

    let model;
    try {
      model = JSON.parse(fs.readFileSync(bmPath, 'utf8'));
    } catch (err) {
      console.error('Cannot parse bm25.json:', err);
      return res.json({ answer: fallback });
    }

    const hits = searchTop(model, query, 5);

    if (!hits.length || hits[0].score < 0.5) {
      return res.json({ answer: fallback });
    }

    const best = hits[0];
    const parentDoc = idx.docs.find(d => d.sourceId === best.sourceId);

    const context = best.text.replace(/\s+/g, ' ').trim();

    const answer = `From: ${parentDoc?.title || 'Guideline'}

${context}

(If this does not fully address your question, please consult a healthcare professional.)`;

    return res.json({ answer });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(500).json({
      answer:
        'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.'
    });
  }
});

// --------------------------------------------------
// ROUTE: GET /api/sources
//
// Returns summary of what's indexed.
// {
//   totalGuidelines: N,
//   guidelines: [
//     { title, sourceId, filename, uploadedAt, lang, chunks }
//   ]
// }
// --------------------------------------------------
app.get('/api/sources', (req, res) => {
  try {
    const idx = loadIndex();

    const list = idx.docs.map(doc => {
      const countForDoc = idx.chunks
        .filter(c => c.sourceId === doc.sourceId)
        .length;
      return {
        title: doc.title,
        sourceId: doc.sourceId,
        filename: doc.filename,
        uploadedAt: doc.uploadedAt,
        lang: doc.lang,
        chunks: countForDoc
      };
    });

    return res.json({
      totalGuidelines: list.length,
      guidelines: list
    });

  } catch (err) {
    console.error('SOURCES ERROR:', err);
    return res
      .status(500)
      .json({ error: 'Unable to list sources' });
  }
});

// --------------------------------------------------
// ROUTE: DELETE /api/source/:sourceId
//
// Requires ?secret=ADMIN_SECRET
//
// Deletes the guideline from index.json and its chunks,
// rebuilds bm25.json, then returns {ok:true,...}.
// --------------------------------------------------
app.delete('/api/source/:sourceId', (req, res) => {
  try {
    const { sourceId } = req.params;
    const { secret } = req.query;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const idx = loadIndex();

    const exists = idx.docs.some(d => d.sourceId === sourceId);
    if (!exists) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // filter out that doc
    const newDocs = idx.docs.filter(d => d.sourceId !== sourceId);
    const newChunks = idx.chunks.filter(c => c.sourceId !== sourceId);

    const newIdx = {
      docs: newDocs,
      chunks: newChunks,
      builtAt: new Date().toISOString()
    };

    // save new index
    saveIndex(newIdx);

    // rebuild BM25 from remaining chunks
    rebuildBm25AndSave(newChunks);

    return res.json({
      ok: true,
      removed: sourceId,
      remainingGuidelines: newDocs.length
    });

  } catch (err) {
    console.error('DELETE SOURCE ERROR:', err);
    return res.status(500).json({ error: 'Failed to delete source' });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(
    'Server running on port ' +
    PORT +
    ' with storage at ' +
    storageDir
  );
});
