# DoubtBoard

Live Q&A for any group: a lecture, workshop, webinar, meetup or study group. People join with a room code, ask questions and vote. While you type, the app suggests **"a similar question already exists, upvote it?"** so the same doubt does not get asked ten times. A moderator can merge and split duplicates, and mark questions answered.

Stack: React + Vite, Node.js + Express, Socket.io, MongoDB (Mongoose). The similarity engine is plain JavaScript (TF-IDF cosine, no ML libraries, no external APIs).

## Run it locally

You need Node 18+ and a MongoDB (local, or a free Atlas cluster).

```bash
npm run install:all
cp server/.env.example server/.env      # set MONGO_URI; set VOTER_SECRET for anything beyond local dev
npm run dev:server                      # API on :4000
npm run dev:client                      # UI on :5173 (proxies /api and /socket.io to :4000)
```

Open http://localhost:5173, create a session, then open the room link in a second browser or a private window to play a student.

## How it works

| Piece | What it does |
|---|---|
| `server/src/similarity.js` | Tokenizer, light stemmer, stopwords, Jaccard baseline, TF-IDF cosine |
| `server/src/suggest.js` | Suggests existing questions above a threshold (IDF fitted with a background corpus) |
| `server/src/ranking.js` | `score = (votes + 1) / (ageHours + 2) ^ gravity`, answered questions sink |
| `server/src/identity.js` | Server-signed anonymous voter tokens (HMAC-SHA256) |
| `server/src/voting.js` | Idempotent votes, vote counts, merge / split vote moves |
| `server/src/answers.js` | Reads answers for a question (own plus those of merged duplicates), derives vote counts, hides author ids |
| `server/src/broadcast.js` | Ranked list builder, plus a coalescing broadcaster (at most one emit per room per 100 ms) |
| `server/eval/evaluate.js` | Precision / recall on labelled pairs, 70/30 split |
| `server/scripts/loadtest.js` | Concurrent sockets, broadcast latency, vote-integrity checks |
| `client/src/` | Join / create, ask box with live suggestions, ranked list, answers panel, moderator controls |

**API** (all JSON). Voter routes need the `x-voter-token` header, moderator routes need `x-mod-token`.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/voters` | none (IP limited) | Issue an anonymous signed identity |
| `POST /api/rooms` | none (IP limited) | Create a room, returns the code and the moderator key once |
| `GET /api/rooms/:code` | none | Room title |
| `GET /api/rooms/:code/questions` | none | Ranked list |
| `GET /api/rooms/:code/my-votes` | voter | Which questions I voted on |
| `POST /api/rooms/:code/similar` | none | Similar existing questions for some text |
| `POST /api/rooms/:code/questions` | voter | Ask (rate limited per voter) |
| `POST` / `DELETE /api/rooms/:code/questions/:id/vote` | voter | Vote / remove vote (both idempotent) |
| `POST .../questions/:id/merge`, `/unmerge`, `/answered` | moderator | Merge into another question, split out, mark answered |
| `DELETE /api/rooms/:code/questions/:id` | moderator | Remove a question (spam, off-topic); votes are cleaned up and any duplicates merged into it become ordinary questions again |
| `GET /api/rooms/:code/questions/:id/answers` | none (token adds `voted` / `mine`) | Ranked answers; `canAccept` is true for the asker |
| `POST /api/rooms/:code/questions/:id/answers` | voter | Answer a question (rate limited per voter, capped per question) |
| `POST` / `DELETE /api/rooms/:code/answers/:aid/vote` | voter | Vote / remove vote on an answer (idempotent; not on your own answer) |
| `DELETE /api/rooms/:code/answers/:aid` | author or moderator | Delete an answer; if it was accepted, the question reopens |
| `POST` / `DELETE /api/rooms/:code/questions/:id/accepted` | asker or moderator | Accept an answer (marks the question answered) / un-accept (reopens) |

Sockets only **receive**: the client emits `room:join` and gets the full list in the acknowledgement, then listens for `questions` pushes and `answers:changed` hints (which tell an open answers panel to re-fetch). All writes go over REST where they are validated and rate limited.

## Design choices (and the reasons to give in an interview)

- **Suggest, never auto-merge.** A wrong automatic merge hides a real doubt. The student decides ("Upvote this" or "Post anyway"); only the moderator can merge.
- **Time-decayed ranking.** A popular question from an hour ago should not sit on top forever. Gravity is configurable (`RANK_GRAVITY`). The client re-fetches once a minute because rank changes with age even when nothing happens.
- **Votes are enforced by the database.** A unique index on `(roomCode, questionId, voterId)` means retries, double clicks and parallel requests cannot create a second vote. Voting twice returns success without changing anything.
- **Voter ids cannot be invented.** The id comes from a token the server signed, never from the request body. Without this, a loop of random ids would walk straight past the unique index.
- **Counts come from the Vote collection, not a cached counter.** A cached counter updated with last-write-wins can end up stale when many votes land together. Counting votes is always right (one indexed aggregation per list build).
- **Merge moves votes and remembers where they came from** (`originQuestionId`), so a split puts them back. A voter who voted on both questions is counted once.
- **Peer answers reuse the vote design.** Answer votes have their own unique index `(roomCode, answerId, voterId)` and counts are aggregated, never cached. Author ids stay on the server: clients only learn `mine`. You cannot vote on your own answer, which blocks the cheapest way to inflate one.
- **Who can accept.** The person who asked (matched by their signed voter id) or the moderator. Accepting marks the question answered and pins that answer first; deleting the accepted answer reopens the question. The answer list is fetched per question, not pushed with every broadcast, so a busy room does not resend every answer on every vote.
- **Answers and merges.** A merged question shows its duplicates' answers on the main question (tagged "from a merged question"). Answers can only be posted to, and accepted on, the main question; a split gives the answers back. Removing a question deletes its answers and their votes.
- **Reconnects are a full re-sync.** On every socket (re)connect the client re-joins and receives the whole list, so a dropped connection never leaves a stale screen.
- **Why TF-IDF and not embeddings:** no model to host, no API cost or latency, and every score can be explained by the words that matched. The cost is real: it does not know that "BST" means "binary search tree".

## Evaluate duplicate detection

```bash
npm run eval                      # uses server/eval/pairs.csv
node server/eval/evaluate.js my_pairs.csv --seed 7
node server/eval/evaluate.js my_pairs.csv --cv 5     # recommended for any number you report
```

The default mode tunes the threshold on a 70% split and reports precision / recall / F1 on the held-out 30%. With ~100 pairs that test half holds only ~8 duplicates, so one pair moves recall by 12 points: use `--cv 5` instead. It tests every pair once (the threshold is tuned on the other folds each time), pools the predictions, and prints bootstrap 95% intervals so you can see how much the numbers could move. Both modes compare TF-IDF against a word-overlap baseline and list the errors. If TF-IDF does not clearly beat the baseline (the intervals overlap), say so in your write-up rather than claiming it does.

### Build your own labelled set

1. Collect 50-60 real questions (classmates, a study-group chat, past exam questions), one per line in `questions.txt`.
   Then run `node eval/find_glued_words.js questions.txt` (add `--write` to get a `.fixed` copy). Text copied from PDFs and chats often has words stuck together ("differencebetween"); each becomes a meaningless token that can never match anything. Fix these before generating pairs.
2. `node eval/make_candidates.js questions.txt --pairs 100 --out eval/candidates.csv` writes candidate pairs with a blank `is_duplicate` column. Candidates are a shuffled mix of look-alike pairs, moderately similar pairs and random pairs, picked with character trigrams so the TF-IDF scorer does not choose its own test questions.
3. Open the CSV in Excel or Sheets, put `1` (same doubt) or `0` (different doubt) on **every** row, save as CSV.
4. `node eval/evaluate.js eval/candidates.csv`. The loader refuses blank or mistyped labels rather than counting them as "not a duplicate".
5. Copy the file over `eval/pairs.csv` if you want production suggestions to use your questions as the IDF background.

Label by the rule "would the same answer satisfy both askers?". Aim for a third to a half of the pairs being duplicates; if there are too few, add paraphrases you write yourself and say so in your write-up.

**Important:** `eval/pairs.csv` is a 40-pair **sample written by an AI assistant to demonstrate the format**. Do not quote its numbers. Replace it with at least ~100 pairs you labelled yourself (real classmate questions where possible, and say in your write-up which pairs were real and which you wrote). CSV header: `question_a,question_b,is_duplicate` (1 = same doubt, 0 = different).

Then set `SIMILARITY_THRESHOLD` from your own results. Also report P/R at 2-3 thresholds, because the choice is a precision / recall trade-off: a lower threshold finds more duplicates but suggests more wrong ones.

`eval/pairs.csv` is also used as the background corpus for IDF at runtime (`BACKGROUND_CSV`). Why: IDF fitted on a room with two or three questions is almost flat, so early duplicates score low. In the sample data, "Explain deadlock in operating systems" against "What is a deadlock in OS?" scores 0.26 from the room alone (missed at the default 0.3) and 0.38 with the background corpus.

## Load test

```bash
# terminal 1: raise the rate limits, otherwise the test just measures the limiter
API_REQUESTS_PER_MINUTE=100000 VOTERS_PER_HOUR=100000 QUESTIONS_PER_MINUTE=1000 ROOMS_PER_HOUR=1000 npm run dev:server
# terminal 2
node server/scripts/loadtest.js --clients 200 --rounds 30 --burst 300
```

It reports join latency, broadcast delivery latency (p50 / p95 / max) and delivery rate, then checks: 25 parallel votes from one voter count once, 300 distinct voters in parallel all count, and an invented voter token is rejected. It exits non-zero if an integrity check fails. Put the printed numbers in your README; do not estimate them.

## Tests

```bash
npm test
```

Runs without a database: similarity, ranking, evaluation maths, signed tokens, suggestion logic, request validation. Fifteen integration tests (parallel duplicate votes, 30 parallel voters, merge / split vote accounting, removing questions, moderator key, suggestions, and the answer rules: ranking, own-vote block, who can accept, delete, merge interplay, cascade on removal) need a real MongoDB and are skipped unless you set a throwaway database:

```bash
MONGO_TEST_URI=mongodb://127.0.0.1:27017/doubtboard_test npm test
```

The database name must contain `test`; the tests drop it.

## Deploy

- **API:** any Node host with WebSocket support (Render, Railway, Fly). Use MongoDB Atlas. Set `MONGO_URI`, `CLIENT_ORIGIN` (your client's URL), and a long random `VOTER_SECRET`. Check that WebSockets actually work on the free tier before you rely on it, and note that free tiers sleep, so the first request after idle is slow.
- **Client:** `npm run build`, host `client/dist` on any static host (Netlify, Vercel, GitHub Pages). Set `VITE_API_URL` to the API's URL at build time. Routing uses the URL hash, so no rewrite rules are needed.
- Behind a proxy the app trusts one hop (`trust proxy 1`) so rate limits see real client IPs.

## Known limits

- **Identity is per browser, not per person.** Clearing site data gives a new identity. The per-IP cap on issuing identities slows scripted abuse but a whole class shares one campus IP, so the cap is generous. Anonymous voting cannot do better without logins.
- **Rate limits are in memory,** so they are per server process.
- **Scaling past one server** needs: the Socket.io Redis adapter, sticky sessions (or WebSocket-only transport), and a shared rate-limit store.
- **The list is rebuilt per broadcast** (one query plus one aggregation). Fine for hundreds of questions; for far more, keep a cached count and a diff-based update.
- Moderator key is stored in plain text in the room document and in the creator's browser. Fine for a class tool; hash it if you extend this.
- Rooms never expire. Add a TTL index if you host it publicly.
- **Evaluation scope:** the labelled pairs and the background questions are all computer-science course questions. The measured precision and recall describe that domain only; do not claim the same accuracy for other topics without adding labelled pairs from them.
- **Anonymous by design.** No accounts: people join with a room code, and the moderator is whoever holds the room's key. That removes friction, but a lost key means nobody can moderate that room.
- **Answers are plain text and anonymous.** Nobody sees who wrote an answer, which lowers the barrier to answering but also means a wrong answer can only be countered by votes or the moderator. Nothing checks that an answer is correct.
- **Future work (not built):** host accounts so rooms belong to a person instead of a key.
- Abbreviations and synonyms defeat TF-IDF ("BST", "OS"). That is a limitation to state, not hide.

## Resume bullets (fill brackets only with numbers you measured)

- Built a real-time Q&A board (React, Node.js, Socket.io, MongoDB) that suggests similar questions with a from-scratch TF-IDF cosine engine and ranks them by time-decayed votes.
- Evaluated duplicate detection on [N] hand-labelled question pairs with a 70/30 split: [X]% precision and [Y]% recall at the chosen threshold, against a [Z]% recall word-overlap baseline.
- Load-tested with [N] concurrent socket connections ([p95] ms p95 broadcast latency); enforced one vote per voter per question with a unique index and server-signed voter tokens, verified under [N] parallel requests.

## Likely interview questions

- Why TF-IDF over embeddings, and what does it miss?
- How did you choose the threshold, and why report on a held-out split?
- How do you stop double votes under retries and parallel requests? What stops someone inventing voter ids?
- Why count votes from the Vote collection instead of keeping a counter on the question?
- What happens when a socket drops and reconnects?
- What happens to votes when a moderator merges two questions, and when they split them?
- How would you scale to many servers?