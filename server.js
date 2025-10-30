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

    const newDocs = idx.docs.filter(d => d.sourceId !== sourceId);
    const newChunks = idx.chunks.filter(c => c.sourceId !== sourceId);

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

