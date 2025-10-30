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

// -----------------------------------------------------------------------------
// Boilerplate to make __dirname work in ES modules
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
// App + middleware
// -----------------------------------------------------------------------------
const app = express();
app.use(cors()); // allow calls from GitHub Pages frontend
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

// Persistent storage path (or in-memory equivalent for free tiers)
// On Render free tier we use /opt/render/project/src/storage
const storageRoot =
  process.env.STORAGE_DIR ||
  process.env.storageDir ||
  path.join(__dirname, 'storage');

const storageDir = path.resolve(storageRoot);
const uploadDir = path.join(storageDir, 'uploads');
const indexPath = path.join(storageDir, 'index.json');
const bmPath = path.join(storageDir, 'bm25.json');

// Ensure folders exist
fs.mkdirSync(uploadDir, { recursive: true });

// -----------------------------------------------------------------------------
// Helpers to load/save the index
// Structure of index.json:
// {
//   docs: [
//     {
//       sourceId,
//       title,
//       filename,
//       lang,
//       uploadedAt
//     },
//     ...
//   ],
//   chunks: [
//     { id, sourceId, text },
//     ...
//   ],
//   builtAt: ISOString
// }
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Multer for file uploads
// -----------------------------------------------------------------------------
const upload = multer({ dest: uploadDir });

// -----------------------------------------------------------------------------
// PDF extraction helper
// -----------------------------------------------------------------------------
async function extractFromPdf(filePath) {
  // try text-based parse first
  const data = await pdfParse(fs.readFileSync(filePath));
  let text = (data.text || '').trim();
  return text;
}

// -----------------------------------------------------------------------------
// Chunking helper
// We split long text into overlapping chunks so search is more targeted
// CH = chunk size, overlap = amount of overlap between chunks
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// ROUTE: GET /api/health
// sanity check route
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, storageDir });
});

// -----------------------------------------------------------------------------
// ROUTE: POST /api/upload
// Admin-only upload of a guideline. Supports:
// - PDFs (text or scanned)
// - DOCX
// - Images (png/jpg/tiff) via OCR
//
// Body form-data:
//   secret = ADMIN_SECRET
//   title  = string (required, becomes "From: ___" in answers)
//   langs  = e.g. "eng" or "eng,chi_sim"
//   file   = file upload
//
// On success:
//   { ok: true, sourceId, title, chunks: n, langGuess }
// -----------------------------------------------------------------------------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { secret, title, langs = 'eng' } = req.body || {};

    // Check auth
    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate
    if (!req.file || !title) {
      return res
        .status(400)
        .json({ error: 'Missing file and/or title field' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const sourceId = uuidv4();
    let text = '';

    // Handle PDF
    if (ext === '.pdf') {
      // Try normal PDF extraction first
      text = (await extractFromPdf(req.file.path)) || '';

      // If it's a scanned PDF (text came back empty),
      // fall back to OCR using Tesseract
      if (!text.trim()) {
        text = await ocrImage(req.file.path, langs);
      }
    }
    // Handle DOCX
    else if (ext === '.doc' || ext === '.docx') {
      text = await extractDocx(req.file.path);
    }
    // Handle images (png/jpg/jpeg/tif/tiff)
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
          'No extractable text found (even after OCR). Check file quality.',
      });
    }

    // auto-detect language (for info only)
    const langGuess = franc(text.slice(0, 4000) || 'unknown');

    // chunk the text
    const newChunks = chunk(text, sourceId);

    // load current index, append new doc + chunks
    const idx = loadIndex();
    idx.docs.push({
      sourceId,
      title,
      filename: req.file.originalname,
      lang: langGuess,
      uploadedAt: new Date().toISOString(),
    });
    idx.chunks.push(...newChunks);
    idx.builtAt = new Date().toISOString();

    // rebuild BM25 after adding new chunks
    const model = buildIndex(idx.chunks);
    fs.writeFileSync(bmPath, JSON.stringify(model), 'utf8');

    // persist updated index
    saveIndex(idx);

    return res.json({
      ok: true,
      sourceId,
      title,
      chunks: newChunks.length,
      langGuess,
    });
  } catch (err) {
    console.error('UPLOAD ERROR:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: POST /api/ask
// User-facing Q&A route.
// Expects JSON body: { query: "user question" }
//
// Returns either:
//   - best chunk from guidelines + safety line
//   - OR fallback safety message if no good match
// -----------------------------------------------------------------------------
app.post('/api/ask', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const fallback =
      'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.';

    // load index
    const idx = loadIndex();

    if (!idx.chunks.length) {
      // no data loaded yet
      return res.json({ answer: fallback });
    }

    // load BM25 model
    if (!fs.existsSync(bmPath)) {
      return res.json({ answer: fallback });
    }
    const modelRaw = fs.readFileSync(bmPath, 'utf8');
    let model;
    try {
      model = JSON.parse(modelRaw);
    } catch (e) {
      console.error('BM25 parse error:', e);
      return res.json({ answer: fallback });
    }

    // Get top hits
    const hits = searchTop(model, query, 5);

    // heuristic: require some minimum score so we don't hallucinate
    if (!hits.length || hits[0].score < 0.5) {
      return res.json({ answer: fallback });
    }

    const best = hits[0];
    const parentDoc = idx.docs.find(
      (d) => d.sourceId === best.sourceId
    );

    const context = best.text.replace(/\s+/g, ' ').trim();

    const answer = `From: ${
      parentDoc?.title || 'Guideline'
    }

${context}

(If this does not fully address your question, please consult a healthcare professional.)`;

    return res.json({ answer });
  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(500).json({
      answer:
        'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.',
    });
  }
});

// -----------------------------------------------------------------------------
// ROUTE: GET /api/sources
// Admin-side "dashboard": shows what guidelines are currently indexed.
// No secret required for now (read-only). If you want to lock this later,
// we can add ?secret=... and check against ADMIN_SECRET.
//
// Returns:
// {
//   totalGuidelines: N,
//   guidelines: [
//     {
//       title, sourceId, filename,
//       uploadedAt, lang, chunks
//     }, ...
//   ]
// }
// -----------------------------------------------------------------------------
app.get('/api/sources', (req, res) => {
  try {
    const idx = loadIndex();

    // summarize docs + how many chunks each has
    const list = idx.docs.map((doc) => {
      const countForDoc = idx.chunks.filter(
        (c) => c.sourceId === doc.sourceId
      ).length;
      return {
        title: doc.title,
        sourceId: doc.sourceId,
        filename: doc.filename,
        uploadedAt: doc.uploadedAt,
        lang: doc.lang,
        chunks: countForDoc,
      };
    });

    return res.json({
      totalGuidelines: list.length,
      guidelines: list,
    });
  } catch (err) {
    console.error('SOURCES ERROR:', err);
    return res
      .status(500)
      .json({ error: 'Unable to list sources' });
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    'Server running on port ' +
      PORT +
      ' with storage at ' +
      storageDir
  );
});
