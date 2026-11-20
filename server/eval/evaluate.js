// Evaluate duplicate detection on labelled pairs.
//
// Usage:
//   node eval/evaluate.js [pairs.csv] [--seed N]        one 70/30 split
//   node eval/evaluate.js [pairs.csv] --cv 5 [--seed N]  5-fold cross-validation (recommended)
//
// Split mode tunes the threshold on 70% of the pairs and reports precision / recall / F1 on the
// held-out 30%. CV mode tests every pair exactly once, tuning the threshold on the other folds each
// time, and reports pooled results with bootstrap 95% intervals. With only ~100 pairs a single
// split has very few duplicates in its test half, so prefer --cv for any number you report.
// The baseline (word overlap) and TF-IDF are both reported.
import { readFileSync } from 'node:fs';
import { OverlapScorer, TfidfScorer } from '../src/similarity.js';
import {
  loadPairs, precisionRecall, bestThreshold, stratifiedSplit, stratifiedFolds, bootstrapCI,
} from '../src/evaluation.js';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = flagValue('seed') !== undefined ? Number(flagValue('seed')) : 42;
const cvK = flagValue('cv') !== undefined ? Number(flagValue('cv')) : null;
const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--seed' && args[i - 1] !== '--cv') ?? 'eval/pairs.csv';

let pairs;
try {
  pairs = loadPairs(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`Cannot evaluate ${path}: ${err.message}`);
  process.exit(1);
}
const dups = pairs.filter((p) => p.label === 1).length;
const f = (x) => x.toFixed(2);
const range = ([lo, hi]) => `${f(lo)}-${f(hi)}`;

const makeScorer = (name, train) =>
  name === 'tfidf cosine'
    // IDF is fitted on training questions only, so the held-out questions stay unseen.
    ? new TfidfScorer().fit([...new Set(train.flatMap((p) => [p.a, p.b]))])
    : new OverlapScorer();
const NAMES = ['overlap (baseline)', 'tfidf cosine'];

function warnIfSmall(testDups) {
  if (dups < 20 || (testDups !== null && testDups < 6)) {
    console.log(
      `WARNING: only ${dups} duplicate pairs${testDups !== null ? ` (${testDups} in the test split)` : ''}. Precision and recall on so few\n` +
      'positives are not meaningful, and the tuned threshold will be degenerate. Do NOT report or use numbers\n' +
      'from this run. Add more real duplicates (aim for 30+).\n'
    );
  }
}

// ---------------------------------------------------------------- cross-validation
function runCv(k) {
  let folds;
  try {
    folds = stratifiedFolds(pairs, k, seed);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`${pairs.length} pairs (${dups} duplicates, ${pairs.length - dups} not): ${k}-fold cross-validation, seed ${seed}.`);
  console.log('Every pair is tested once; each fold tunes its threshold on the other folds.\n');
  warnIfSmall(null);

  const errorsByName = {};
  for (const name of NAMES) {
    const decisions = [];
    const scoredAll = [];
    const thresholds = [];
    for (const { train, test } of folds) {
      const scorer = makeScorer(name, train);
      const t = bestThreshold(train.map((p) => ({ score: scorer.score(p.a, p.b), label: p.label })));
      thresholds.push(t);
      for (const p of test) {
        const score = scorer.score(p.a, p.b);
        scoredAll.push({ score, label: p.label });
        decisions.push({ predicted: score >= t, label: p.label, score, a: p.a, b: p.b });
      }
    }
    const r = precisionRecall(decisions.map((d) => ({ score: d.predicted ? 1 : 0, label: d.label })), 1);
    const ci = bootstrapCI(decisions);
    console.log(`${name}`);
    console.log(`  pooled over all ${decisions.length} pairs: P=${f(r.precision)} R=${f(r.recall)} F1=${f(r.f1)}   (TP ${r.tp}, FP ${r.fp}, FN ${r.fn})`);
    console.log(`  95% interval:  P ${range(ci.precision)}   R ${range(ci.recall)}`);
    console.log(`  per-fold thresholds: ${thresholds.map((t) => t.toFixed(2)).join(', ')}`);
    console.log('  at a fixed threshold (pooled):');
    for (const fixed of [0.2, 0.3, 0.4, 0.5]) {
      const x = precisionRecall(scoredAll, fixed);
      console.log(`    ${fixed.toFixed(1)}: P=${f(x.precision)} R=${f(x.recall)}`);
    }
    console.log();
    errorsByName[name] = decisions.filter((d) => d.predicted !== (d.label === 1));
  }

  const errs = errorsByName['tfidf cosine'];
  const fps = errs.filter((e) => e.label === 0).sort((x, y) => y.score - x.score);
  const fns = errs.filter((e) => e.label === 1).sort((x, y) => x.score - y.score);
  const show = (title, list) => {
    console.log(`${title} (${list.length}):`);
    for (const e of list.slice(0, 15)) console.log(`  ${e.score.toFixed(2)}: "${e.a}" | "${e.b}"`);
    if (list.length > 15) console.log(`  ... and ${list.length - 15} more`);
    console.log();
  };
  show('tfidf false positives (suggested, but labelled different)', fps);
  show('tfidf missed duplicates (labelled same, not suggested)', fns);
  console.log('Before trusting the numbers, re-read the labels on the pairs above using one rule:');
  console.log('"would the same answer satisfy both askers?". Fix only clear labelling mistakes, and apply the');
  console.log('same rule to a random sample of the other rows too, so you are not tuning labels to the scorer.');
}

// ---------------------------------------------------------------- single split
function runSplit() {
  const { train, test } = stratifiedSplit(pairs, 0.7, seed);
  console.log(`${pairs.length} pairs (${dups} duplicates, ${pairs.length - dups} not) -> ${train.length} train / ${test.length} test, seed ${seed}\n`);
  const testDups = test.filter((p) => p.label === 1).length;
  warnIfSmall(testDups);
  if (dups >= 20 && testDups < 12) {
    console.log(`Note: the test split has only ${testDups} duplicates, so one pair moves recall by ${Math.round(100 / testDups)} points.`);
    console.log('Run with --cv 5 for a steadier estimate.\n');
  }

  let tfidfThreshold = 0;
  const scorers = {};
  for (const name of NAMES) {
    const scorer = makeScorer(name, train);
    scorers[name] = scorer;
    const trainScored = train.map((p) => ({ score: scorer.score(p.a, p.b), label: p.label }));
    const testScored = test.map((p) => ({ score: scorer.score(p.a, p.b), label: p.label }));
    const t = bestThreshold(trainScored);
    const r = precisionRecall(testScored, t);
    console.log(`${name}: threshold ${t.toFixed(3)} (tuned on train) -> test P=${f(r.precision)} R=${f(r.recall)} F1=${f(r.f1)}`);
    for (const fixed of [0.2, 0.3, 0.4, 0.5]) {
      const x = precisionRecall(testScored, fixed);
      console.log(`    at ${fixed.toFixed(1)}: P=${f(x.precision)} R=${f(x.recall)}`);
    }
    console.log();
    if (name === 'tfidf cosine') tfidfThreshold = t;
  }

  // Error analysis: look at these when tuning tokenization and when writing the README.
  console.log('Test errors for tfidf:');
  let errors = 0;
  for (const p of test) {
    const s = scorers['tfidf cosine'].score(p.a, p.b);
    if ((s >= tfidfThreshold) !== (p.label === 1)) {
      errors++;
      console.log(`  [${p.label === 0 ? 'false positive' : 'missed duplicate'}] ${s.toFixed(2)}: "${p.a}" | "${p.b}"`);
    }
  }
  if (errors === 0) console.log('  none');
}

if (cvK !== null) runCv(cvK);
else runSplit();