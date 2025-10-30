import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { v4 as uuidv4 } from 'uuid';
import { extractDocx } from './parsers/extractDocx.js';
import { ocrImage } from './parsers/ocrImage.js';
import { buildIndex, searchTop } from './search/bm25.js';
import { franc } from 'franc-min';

const app = express();
app.use(cors()); // allow frontend on GitHub Pages
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

// persistent storage path (Railway volume should mount here)
const storageRoot = process.env.STORAGE_DIR || '/app/storage';
const storageDir = path.resolve(storageRoot);
const uploadDir = path.join(storageDir, 'uploads');
const indexPath  = path.join(storageDir, 'index.json');
const bmPath     = path.join(storageDir, 'bm25.json');

fs.mkdirSync(uploadDir, { recursive: true });

function loadIndex() {
  if (fs.existsSync(indexPath)) {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  return { docs: [], chunks: [], builtAt: null };
}
function saveIndex(idx) {
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
}

const upload = multer({ dest: uploadDir });

async function extractFromPdf(filePath) {
  const data = await pdfParse(fs.readFileSync(filePath));
  let text = (data.text || '').trim();
  return text;
}

function chunk(text, sourceId, CH=1200, overlap=120) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i+CH);
    chunks.push({ id: uuidv4(), sourceId, text: slice });
    i += (CH - overlap);
  }
  return chunks;
}

app.get('/api/health', (_, res) => res.json({ ok: true, storageDir }));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { secret, title, langs='eng' } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file || !title) return res.status(400).json({ error: 'Missing file/title' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const sourceId = uuidv4();
    let text = '';

    if (ext === '.pdf') {
      text = (await extractFromPdf(req.file.path)) || '';
      if (!text.trim()) {
        // scanned PDF fallback: OCR
        text = await ocrImage(req.file.path, langs);
      }
    } else if (ext === '.docx') {
      text = await extractDocx(req.file.path);
    } else if (['.png','.jpg','.jpeg','.tif','.tiff'].includes(ext)) {
      text = await ocrImage(req.file.path, langs);
    } else {
      return res.status(415).json({ error: 'Unsupported file type' });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No extractable text found (even after OCR).' });
    }

    const langGuess = franc(text.slice(0, 4000) || 'unknown');
    const chunks = chunk(text, sourceId);

    const idx = loadIndex();
    idx.docs.push({
      sourceId,
      title,
      filename: req.file.originalname,
      lang: langGuess,
      uploadedAt: new Date().toISOString()
    });
    idx.chunks.push(...chunks);
    idx.builtAt = new Date().toISOString();

    const model = buildIndex(idx.chunks);
    fs.writeFileSync(bmPath, JSON.stringify(model));
    saveIndex(idx);

    res.json({ ok: true, sourceId, title, chunks: chunks.length, langGuess });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/ask', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const fallback = 'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.';

    const idx = loadIndex();
    if (!idx.chunks.length) {
      return res.json({ answer: fallback });
    }

    const model = JSON.parse(fs.readFileSync(bmPath, 'utf8'));
    const hits = searchTop(model, query, 5);

    if (!hits.length || hits[0].score < 0.5) {
      return res.json({ answer: fallback });
    }

    const best = hits[0];
    const doc = idx.docs.find(d => d.sourceId === best.sourceId);
    const context = best.text.replace(/\s+/g,' ').trim();

    const answer =
`From: ${doc?.title || 'Guideline'}

${context}

(If this does not fully address your question, please consult a healthcare professional.)`;

    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      answer: 'Sorry, I am unable to assist you with your current query. I would recommend you to speak to a healthcare professional for more advice.'
    });
  }
});

app.listen(PORT, () => {
  console.log('Server running on ' + PORT + ' with storage at ' + storageDir);
});
