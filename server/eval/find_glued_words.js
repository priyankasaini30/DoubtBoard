// Find words that were accidentally glued together ("differencebetween", "andwhat", "samehash").
// They usually come from copy-pasting out of a PDF or a chat, and each one becomes a meaningless
// token that cannot match anything, which quietly hurts both the evaluation and the live suggestions.
//
// Usage:
//   node eval/find_glued_words.js eval/candidates.csv            list suspects
//   node eval/find_glued_words.js eval/candidates.csv --write    also write <file>.fixed.<ext> with the
//                                                                 likely fixes applied (review the list first)
//   (works on questions.txt too: one question per line)
//
// List 1 "likely glued": a rare word that splits into two words that appear elsewhere in your data.
// List 2 "check by eye": long words that appear in only one question. Most are real words
// ("normalization"); look for ones that are two words stuck together.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from '../src/evaluation.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node eval/find_glued_words.js <questions.txt | pairs.csv> [--write]');
  process.exit(1);
}
const write = args.includes('--write');

const raw = readFileSync(file, 'utf8').replace(/^﻿/, '');
let lines;
if (file.toLowerCase().endsWith('.csv')) {
  const first = raw.split(/\r?\n/, 1)[0];
  const delimiter = !first.includes(',') && first.includes(';') ? ';' : ',';
  const rows = parseCsv(raw, delimiter).slice(1);
  lines = [...new Set(rows.flatMap((r) => [r[0], r[1]]).filter(Boolean))];
} else {
  lines = [...new Set(raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

// How many distinct questions contain each word.
const lineCount = new Map();
for (const line of lines) {
  for (const w of new Set(line.toLowerCase().match(/[a-z0-9]+/g) ?? [])) lineCount.set(w, (lineCount.get(w) ?? 0) + 1);
}
const COMMON = new Set('a an the is are was of in on at to for and or what why how when which who it its this that same with by as be can do does did not'.split(' '));
const known = (w) => COMMON.has(w) || (lineCount.get(w) ?? 0) >= 2;
// Real compound words that should never be split.
const REAL = new Set(`database databases dataset datasets without within another whether however therefore
overflow underflow deadlock deadlocks multithreading bitwise runtime namespace backtracking bottleneck
firewall workflow hardware software middleware bandwidth`.split(/\s+/));

const likely = [];
const eye = [];
for (const [w, n] of lineCount) {
  if (n > 2 || known(w) || w.length < 5 || REAL.has(w)) continue;
  let split = null;
  for (let i = 2; i <= w.length - 2 && !split; i++) {
    const left = w.slice(0, i);
    const right = w.slice(i);
    if (known(left) && known(right)) split = [left, right];
  }
  if (split) likely.push({ w, split, n });
  else if (w.length >= 9 && n === 1 && !/^\d/.test(w)) eye.push(w);
}

console.log(`${lines.length} distinct questions scanned in ${file}\n`);
console.log(`Likely glued (${likely.length}):`);
for (const { w, split } of likely.sort((x, y) => x.w.localeCompare(y.w))) console.log(`  ${w}  ->  ${split[0]} ${split[1]}`);
if (!likely.length) console.log('  none');
console.log(`\nCheck by eye (${eye.length}) long words in a single question:`);
console.log(`  ${eye.sort().join(', ') || 'none'}\n`);

if (write && !likely.length) {
  console.log('Nothing to fix automatically, so no .fixed file was written.');
} else if (write) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = raw;
  for (const { split } of likely) {
    text = text.replace(new RegExp(`\\b(${escape(split[0])})(${escape(split[1])})\\b`, 'gi'), '$1 $2');
  }
  const dot = file.lastIndexOf('.');
  const out = dot > 0 ? `${file.slice(0, dot)}.fixed${file.slice(dot)}` : `${file}.fixed`;
  writeFileSync(out, text);
  console.log(`Wrote ${out} with the "likely glued" fixes applied. Anything in the check-by-eye list is NOT changed.`);
  console.log('Open it and compare before replacing your original.');
}