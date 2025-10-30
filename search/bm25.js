const k1 = 1.5;
const b = 0.75;

function tokenize(s){
  return s.toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u4E00-\u9FFF]+/g,' ')
    .split(/\s+/).filter(Boolean);
}

export function buildIndex(chunks){
  // docs: array of {id, sourceId, text}
  const docs = chunks.map((c,i) => ({ id:i, sourceId:c.sourceId, text:c.text }));
  // corpus: token arrays
  const corpus = docs.map(d => tokenize(d.text));
  // df: document frequency map
  const df = new Map();
  // tf: term freq per doc
  const tf = corpus.map(tokens => {
    const map = new Map();
    tokens.forEach(t => map.set(t, (map.get(t)||0)+1));
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t)||0)+1);
    }
    return map;
  });

  const N = docs.length;
  const avgdl = corpus.reduce((a,toks)=>a+toks.length,0) / Math.max(1,N);

  // convert Maps to plain objects so we can JSON serialize
  return {
    docs,
    df: Object.fromEntries(df),
    tf: tf.map(m => Object.fromEntries(m)),
    N,
    avgdl
  };
}

export function searchTop(model, query, k=5){
  const qterms = Array.from(new Set(
    (query||'').toLowerCase().split(/\s+/).filter(Boolean)
  ));

  const results = [];

  for (let i=0;i<model.docs.length;i++){
    // doc length = sum tf values
    const tfDoc = model.tf[i];
    const dl = Object.values(tfDoc).reduce((a,b)=>a+b,0) || 0;

    let score = 0;
    for (const t of qterms){
      const ni = model.df[t]||0;
      if (!ni) continue;
      // IDF
      const idf = Math.log( (model.N - ni + 0.5)/(ni + 0.5) + 1 );
      // term freq in this doc
      const fii = tfDoc[t]||0;
      const denom = fii + k1 * (1 - b + b * (dl / (model.avgdl||1)));
      score += idf * ( (fii * (k1 + 1)) / (denom || 1) );
    }

    if (score > 0){
      results.push({
        id: i,
        sourceId: model.docs[i].sourceId,
        score,
        text: model.docs[i].text
      });
    }
  }

  results.sort((a,b)=>b.score-a.score);
  return results.slice(0,k);
}
