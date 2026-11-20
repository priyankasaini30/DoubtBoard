// Loads the background questions used to fit IDF (see suggest.js).
// By default these are the questions in the labelled evaluation file, so replacing
// eval/pairs.csv with your own pairs updates production scoring as well.
import { readFileSync } from 'node:fs';
import { loadPairs } from './evaluation.js';

export function loadBackground(file) {
  try {
    const pairs = loadPairs(readFileSync(file, 'utf8'));
    return [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  } catch (err) {
    console.warn(`No background questions loaded from ${file} (${err.message}); using room questions only.`);
    return [];
  }
}
