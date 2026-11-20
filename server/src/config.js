import 'dotenv/config';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/doubtboard',
  // Comma-separated list of allowed browser origins, or * for any (dev only).
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  // Cosine similarity at or above this triggers a "similar question exists" suggestion.
  // Tune it with `npm run eval` on your own labelled pairs, then set it here.
  similarityThreshold: num(process.env.SIMILARITY_THRESHOLD, 0.3),
  rankGravity: num(process.env.RANK_GRAVITY, 1.5),
  maxQuestionsPerRoom: num(process.env.MAX_QUESTIONS_PER_ROOM, 1000),
  // Per-voter limit on posting answers, and a cap per question (in-memory limiter, like questions).
  answersPerMinute: num(process.env.ANSWERS_PER_MINUTE, 5),
  maxAnswersPerQuestion: num(process.env.MAX_ANSWERS_PER_QUESTION, 50),
  // Per-voter limit on posting questions (in-memory; see README for multi-server notes).
  questionsPerMinute: num(process.env.QUESTIONS_PER_MINUTE, 5),
  // Per-IP limits.
  apiRequestsPerMinute: num(process.env.API_REQUESTS_PER_MINUTE, 600),
  roomsPerHour: num(process.env.ROOMS_PER_HOUR, 20),
  // Anonymous voter identities issued per IP per hour. A whole class on one campus
  // network shares an IP, so keep this well above the class size.
  votersPerHour: num(process.env.VOTERS_PER_HOUR, 500),
  // Secret that signs voter tokens. Set it in production; without it a random one is
  // generated at start-up and every restart invalidates all voter tokens.
  voterSecret: process.env.VOTER_SECRET || crypto.randomBytes(32).toString('hex'),
  voterSecretIsEphemeral: !process.env.VOTER_SECRET,
  // Questions used to fit IDF for duplicate suggestions (see src/suggest.js).
  backgroundCsv: process.env.BACKGROUND_CSV ?? fileURLToPath(new URL('../eval/pairs.csv', import.meta.url)),
};

export function corsOrigin() {
  if (config.clientOrigin === '*') return true;
  return config.clientOrigin.split(',').map((s) => s.trim()).filter(Boolean);
}