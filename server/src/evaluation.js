// Evaluation helpers for duplicate detection (precision / recall / threshold tuning).

// Minimal CSV parser: handles quoted fields, escaped quotes ("") and CRLF.
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// CSV with header: question_a,question_b,is_duplicate  ->  [{a, b, label}]
export function loadPairs(csvText) {
  // Tolerate what spreadsheets and Windows tools do to CSV files: a byte-order mark at the
  // start (Excel's "CSV UTF-8", PowerShell's -Encoding utf8), and ";" instead of "," in
  // some regional settings.
  const text = csvText.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const [header = [], ...rows] = parseCsv(text, delimiter);
  const cols = header.map((h) => h.trim().toLowerCase());
  const ia = cols.indexOf('question_a');
  const ib = cols.indexOf('question_b');
  const il = cols.indexOf('is_duplicate');
  if (ia < 0 || ib < 0 || il < 0) {
    throw new Error(`CSV header must be: question_a,question_b,is_duplicate (found: ${JSON.stringify(header)})`);
  }
  // Strict on purpose: a blank or mistyped label must never silently count as "not a
  // duplicate", because that would quietly corrupt the precision and recall numbers.
  return rows.map((r, i) => {
    const a = (r[ia] ?? '').trim();
    const b = (r[ib] ?? '').trim();
    const raw = (r[il] ?? '').trim();
    if (!a || !b) throw new Error(`Row ${i + 2}: both questions are required.`);
    if (raw !== '0' && raw !== '1') {
      throw new Error(`Row ${i + 2}: is_duplicate must be 0 or 1, got "${raw}". Finish labelling before running the evaluation.`);
    }
    return { a, b, label: Number(raw) };
  });
}

// scored: [{ score, label }]
export function precisionRecall(scored, threshold) {
  let tp = 0, fp = 0, fn = 0;
  for (const { score, label } of scored) {
    const predicted = score >= threshold;
    if (predicted && label === 1) tp++;
    else if (predicted && label === 0) fp++;
    else if (!predicted && label === 1) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn };
}

// Pick the threshold with the best F1 on the given scored pairs.
export function bestThreshold(scored) {
  const candidates = [...new Set(scored.map((s) => Math.round(s.score * 1000) / 1000))].sort((x, y) => x - y);
  let best = candidates[0] ?? 0.5;
  let bestF1 = -1;
  for (const t of candidates) {
    const { f1 } = precisionRecall(scored, t);
    if (f1 > bestF1) { bestF1 = f1; best = t; }
  }
  return best;
}

// Small seeded PRNG so splits are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stratified k-fold: every pair lands in exactly one test fold, and each fold keeps the
// duplicate / non-duplicate mix. Returns [{ train, test }]. With a small labelled set this is
// far less noisy than one 70/30 split, because every pair is tested once.
export function stratifiedFolds(pairs, k = 5, seed = 42) {
  const positives = pairs.filter((p) => p.label === 1).length;
  if (!Number.isInteger(k) || k < 2 || k > positives) {
    throw new Error(`--cv needs a whole number between 2 and the number of duplicate pairs (${positives}), got ${k}.`);
  }
  const rand = mulberry32(seed);
  const foldOf = new Map();
  for (const label of [0, 1]) {
    const group = pairs.filter((p) => p.label === label);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    group.forEach((p, idx) => foldOf.set(p, idx % k));
  }
  return Array.from({ length: k }, (_, f) => ({
    train: pairs.filter((p) => foldOf.get(p) !== f),
    test: pairs.filter((p) => foldOf.get(p) === f),
  }));
}

// Bootstrap 95% interval for precision and recall, from pooled predictions
// [{ predicted: boolean, label: 0 | 1 }]. It shows how much the numbers could move on a
// different sample of questions, which matters when the dataset is small.
export function bootstrapCI(predictions, resamples = 1000, seed = 7) {
  const rand = mulberry32(seed);
  const n = predictions.length;
  const ps = [];
  const rs = [];
  for (let b = 0; b < resamples; b++) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < n; i++) {
      const x = predictions[Math.floor(rand() * n)];
      if (x.predicted && x.label === 1) tp++;
      else if (x.predicted) fp++;
      else if (x.label === 1) fn++;
    }
    ps.push(tp + fp ? tp / (tp + fp) : 0);
    rs.push(tp + fn ? tp / (tp + fn) : 0);
  }
  const pick = (arr, p) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return { precision: [pick(ps, 0.025), pick(ps, 0.975)], recall: [pick(rs, 0.025), pick(rs, 0.975)] };
}

// Stratified split, so the train and test sets both keep the duplicate / non-duplicate mix.
export function stratifiedSplit(pairs, trainFrac = 0.7, seed = 42) {
  const rand = mulberry32(seed);
  const train = [];
  const test = [];
  for (const label of [0, 1]) {
    const group = pairs.filter((p) => p.label === label);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    const k = Math.floor(group.length * trainFrac);
    train.push(...group.slice(0, k));
    test.push(...group.slice(k));
  }
  return { train, test };
}