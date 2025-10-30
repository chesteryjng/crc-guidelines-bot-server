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
// Boilerplate to emulate __dirname in ES modules
// --------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// App + config
// --------------------------------------------------
const app = express();
app.use(cors()); // allow GitHub Pages frontend to call this API
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

// Where we store uploads and index data
// On Render free tier, this points to /opt/render/project/src/storage
const storageRoot =
  process.env.STORAGE_DIR ||
  process.env.storageDir ||
  path.join(__dirname, 'storage');

const storageDir = path.resolve(storageRoot);
const uploadDir = path.join(storageDir, 'uploads');
const indexPath = path.join(storageDir, 'index.json');
const bmPath = path.join(storageDir, 'bm25.json');

// Ensure required dirs exist
fs.mkdirSync(uploadDir, { recursive: true });

// --------------------------------------------------
// Index structure helpers
// index.json format:
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
      console.error('Error parsing index.json, resetting.', err);
    }
  }
  return { docs: [], chunks: [], builtAt: null };
}

function saveIndex(idx) {
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
}

// --------------------------------------------------
// Build BM25 model and save it
// --------------------------------------------------
function rebuildBm25AndSave(chunksArray) {
  const model = buildIndex(chunksArray);
  fs.writeFileSync(bmPath, JSON.stringify(model), 'utf8');
}

// --------------------------------------------------
// Multer for file uploads
// --------------------------------------------------
const upload = multer({ dest: uploadDir });

// --------------------------------------------------
// PDF extraction
// --------------------------------------------------
async function extractFromPdf(filePath) {
  const data = await pdfParse(fs.readFileSync(filePath));
  const text = (data.text || '').trim();
  return text;
}

// --------------------------------------------------
// Chunking for search
// We break long guideline text into overlapping pieces
// so search can return focused passages.
// CH = chunk size, overlap = how much we carry over
// --------------------------------------------------
function chunk(text, sourceId, CH = 1200, overlap = 120) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + CH);
    chunks.push({ id: uuidv4(), sourceId, text: slice });
    i += (CH - overlap);
  }
  return chunks;
}

// --------------------------------------------------
// ROUTE: GET /api/health
// basic health check
// --------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, storageDir });
});

// --------------------------------------------------
// ROUTE: POST /api/upload
// Upload and index one guideline (PDF / DOCX / image w OCR)
//
// Multipart/form-data body:
//   secret = ADMIN_SECRET
//   title  = guideline title (required)
//   langs  = OCR languages e.g. "eng" or "eng,chi_sim"
//   file   = actual file
//
// Returns on success:
// {
//   ok: true,
//   sourceId: "...",
//   title: "NCCN Colon v2025",
//   chunks: 87,
//   langGuess: "eng"
// }
// --------------------------------------------------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { secret, title, langs = 'eng' } = req.body || {};

    // auth check
    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.file || !title) {
      return res
        .status(400)
        .json({ error: 'Missing file and/or title field' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const sourceId = uuidv4();
    let text = '';

    // PDF
    if (ext === '.pdf') {
      text = (await extractFromPdf(req.file.path)) || '';

      // fallback OCR if PDF is scanned and had no text
      if (!text.trim()) {
        text = await ocrImage(req.file.path, langs);
      }
    }
    // DOC / DOCX
    else if (ext === '.doc' || ext === '.docx') {
      text = await extractDocx(req.file.path);
    }
    // Image formats -> OCR
    else if (
      ext === '.png' ||
      ext === '.jpg' ||
      ext === '.jpeg' ||
      ext === '.tif' ||
      ext === '.tiff'
    ) {
      text = await ocrImage(req.file.path, langs);
    } else {
      return res
        .status(415)
        .json({ error: `Unsupported file type: ${ext}` });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        error:
          'No extractable text found (even after OCR). Check file quality.'
      });
    }

    // guess language (just for info)
    const langGuess = franc(text.slice(0, 4000) || 'unknown');

    // break text into searchable chunks
    const newChunks = chunk(text, sourceId);

    // load index, append
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

    // rebuild BM25 model after adding
    rebuildBm25AndSave(idx.chunks);

    // persist index
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
// User question -> best-matching passage from guidelines.
// Request body JSON:
//   { "query": "What is surveillance interval after polypectomy?" }
//
// Returns:
//   { "answer": "From: NCCN Colon v2025 ...[passage]..." }
// or fallback safe advice if not found / too weak.
// --------------------------------------------------
app.post('/api/ask', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const fallback =
      'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.';

    // load in-memory index
    const idx = loadIndex();
    if (!idx.chunks.length) {
      return res.json({ answer: fallback });
    }

    // load BM25 model
    if (!fs.existsSync(bmPath)) {
      return res.json({ answer: fallback });
    }

    let model;
    try {
      model = JSON.parse(fs.readFileSync(bmPath, 'utf8'));
    } catch (e) {
      console.error('BM25 parse error:', e);
      return res.json({ answer: fallback });
    }

    // search
    const hits = searchTop(model, query, 5);

    // require some minimum relevance or we fail-safe
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
// Returns a summary list of indexed guidelines.
// Response:
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
      const countForDoc = idx.chunks.filter(
        c => c.sourceId === doc.sourceId
      ).length;
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
// Removes one guideline (and its chunks) then rebuilds BM25.
// Requires ?secret=... that matches ADMIN_SECRET.
//
// Example request:
//   DELETE /api/source/123e4567...?secret=ColonCare$2025
//
// Response:
//   { ok: true, removed: "123e4567", remainingGuidelines: 1 }
// --------------------------------------------------
app.delete('/api/source/:sourceId', (req, res) => {
  try {
    const { sourceId } = req.params;
    const { secret } = req.query;

    // auth check
    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // load current index
    const idx = loadIndex();

    // does it exist?
    const exists = idx.docs.some(d => d.sourceId === sourceId);
    if (!exists) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // remove doc and its chunks
    const newDocs = idx.docs.filter(d => d.sourceId !== sourceId);
    const newChunks = idx.chunks.filter(c => c.sourceId !== sourceId);

    // rebuild index and BM25
    const newIdx = {
      docs: newDocs,
      chunks: newChunks,
      builtAt: new Date().toISOString()
    };
    saveIndex(newIdx);
    rebuildBm25AndSave(newChunks);

    return res.json({
      ok: true,
      removed: sourceId,
      remainingGuidelines: newDocs.length
    });
  } catch (err) {
    console.error('DELETE SOURCE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to delete source'
    });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(
    'Server running on port ' +
      PORT +
      ' with storage at ' +
      storageDir
  );
});
