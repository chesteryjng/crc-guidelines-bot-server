// search/bm25.js
//
// Minimal BM25-style retrieval over chunked guideline text.
// We store doc-term frequencies and compute a relevance score
// for the user's query.

function tokenize(str) {
  // Lowercase, keep alphanumerics + CJK (for Chinese guidelines),
  // split on anything else.
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Build an index model from chunks:
// chunks = [ { id, sourceId, text }, ... ]
export function buildIndex(chunks) {
  // Each chunk becomes a "doc" in the BM25 sense
  const docs = chunks.map(ch => {
    const tokens = tokenize(ch.text);
    const freq = {};
    tokens.forEach(t => {
      freq[t] = (freq[t] || 0) + 1;
    });
    return {
      id: ch.id,
      sourceId: ch.sourceId,
      text: ch.text,
      freq,          // term -> count
      len: tokens.length
    };
  });

  // document frequency per term
  const df = {};
  docs.forEach(doc => {
    for (const term in doc.freq) {
      df[term] = (df[term] || 0) + 1;
    }
  });

  const N = docs.length;
  const avgdl = N > 0
    ? docs.reduce((sum, d) => sum + d.len, 0) / N
    : 0;

  return { docs, df, N, avgdl };
}

// Query the index using simple BM25
export function searchTop(model, query, k = 5) {
  const { docs, df, N, avgdl } = model;

  if (!docs || !docs.length) {
    return [];
  }

  const qTokens = tokenize(query);

  function bm25Score(doc) {
    // BM25 params
    const k1 = 1.5;
    const b = 0.75;

    // accumulate score across query terms
    let score = 0;

    // for each distinct term in query
    const seen = new Set();
    for (const term of qTokens) {
      if (seen.has(term)) continue;
      seen.add(term);

      const n_qi = df[term] || 0;
      if (!n_qi) continue; // no doc has this term at all

      const f_qi = doc.freq[term] || 0;
      if (!f_qi) continue; // this doc doesn't have this term

      // IDF
      const idf = Math.log(
        ( (N - n_qi + 0.5) / (n_qi + 0.5) ) + 1
      );

      // term frequency scaling
      const denom =
        f_qi +
        k1 * (1 - b + b * (doc.len / (avgdl || 1)));

      score += idf * ( (f_qi * (k1 + 1)) / denom );
    }

    return score;
  }

  // score all docs
  const scored = docs.map(doc => ({
    sourceId: doc.sourceId,
    text: doc.text,
    score: bm25Score(doc)
  }));

  // sort high → low
  scored.sort((a, b) => b.score - a.score);

  // return top k
  return scored.slice(0, k);
}
