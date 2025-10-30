# CRC Guidelines Bot — Railway Backend

This Node/Express service:
- Accepts guideline uploads (PDF, DOCX, or images).
- Runs PDF parsing / DOCX parsing / OCR.
- Splits text into chunks and builds a BM25 search index.
- Answers questions ONLY using uploaded text.
- If no good match: returns the fallback clinical safety message.

Persistent storage:
- The service writes to /app/storage (or STORAGE_DIR env var).
- On Railway, create a Volume and mount it at /app/storage.
- That keeps uploads + index across restarts.

Environment variables to set in Railway:
- ADMIN_SECRET = your strong password for admin uploads
- STORAGE_DIR  = /app/storage (optional; default is /app/storage)

Build command in Railway:
- npm install

Start command in Railway:
- npm start

Endpoints:
- GET /api/health
- POST /api/upload    (multipart form-data: secret, title, langs, file)
- POST /api/ask       (JSON: { "query": "..." })

Your GitHub Pages admin.html will:
- Ask you for Backend API Base URL (the Railway URL)
- Ask you for the same ADMIN_SECRET
- Let you upload guidelines and build/update the index
