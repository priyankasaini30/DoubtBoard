// Load test for a running DoubtBoard server.
//
// Usage:  node scripts/loadtest.js [--url http://localhost:4000] [--clients 200] [--rounds 30] [--burst 300]
//
// What it measures (copy the printed numbers into your README; do not invent any):
//   1. Join latency       : socket connect + room:join ack, for N concurrent clients
//   2. Broadcast latency  : time from a vote request being sent until each client receives
//                           the updated ranked list (p50 / p95 / max across clients and rounds)
//   3. Vote integrity     : the same voter votes 25 times in parallel -> count must rise by exactly 1
//   4. Burst correctness  : B distinct voters vote in parallel -> final count must equal B
//
// Raise the server's rate limits for the test, e.g.
//   API_REQUESTS_PER_MINUTE=100000 VOTERS_PER_HOUR=100000 QUESTIONS_PER_MINUTE=1000 ROOMS_PER_HOUR=1000 npm start
import { io } from 'socket.io-client';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL_BASE = arg('url', 'http://localhost:4000');
const CLIENTS = Number(arg('clients', 200));
const ROUNDS = Number(arg('rounds', 30));
const BURST = Number(arg('burst', 300));

const now = () => performance.now();
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = (label, arr) =>
  console.log(
    `${label.padEnd(26)} n=${arr.length}  p50=${pct(arr, 50).toFixed(1)}ms  p95=${pct(arr, 95).toFixed(1)}ms  max=${arr.length ? Math.max(...arr).toFixed(1) : 'NaN'}ms`
  );

async function api(path, method = 'GET', body, voterToken) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(voterToken ? { 'x-voter-token': voterToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error ?? ''}`);
  return data;
}

// Every voter needs a server-signed identity, exactly like a real browser.
const newVoter = async () => (await api('/api/voters', 'POST')).voterToken;

async function main() {
  console.log(`Target ${URL_BASE}: ${CLIENTS} clients, ${ROUNDS} rounds, burst ${BURST}\n`);
  const { code } = await api('/api/rooms', 'POST', { title: 'Load test room' });
  const asker = await newVoter();
  const q = await api(`/api/rooms/${code}/questions`, 'POST', { text: 'What is a deadlock in OS?' }, asker);
  const qid = q.id;
  const votesNow = async () => (await api(`/api/rooms/${code}/questions`)).questions.find((x) => x.id === qid).votes;

  // ---- 1. concurrent joins ----
  const joinTimes = [];
  let joinFailures = 0;
  const waiters = new Set(); // functions called with every received list
  const sockets = await Promise.all(
    Array.from({ length: CLIENTS }, () => {
      const t0 = now();
      return new Promise((resolve) => {
        const s = io(URL_BASE, { transports: ['websocket'], reconnection: false });
        s.on('connect_error', () => { joinFailures++; resolve(null); });
        s.on('connect', () => {
          s.emit('room:join', code, (ack) => {
            if (ack?.ok) joinTimes.push(now() - t0);
            else joinFailures++;
            resolve(s);
          });
        });
        s.on('questions', (list) => { for (const w of waiters) w(s, list); });
      });
    })
  );
  const live = sockets.filter(Boolean);
  summary('join (connect + ack)', joinTimes);
  console.log(`connected: ${live.length}/${CLIENTS}, join failures: ${joinFailures}\n`);

  // ---- 2. broadcast latency ----
  const delivery = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const voterToken = await newVoter(); // identity issued before the clock starts
    const expected = round; // each round adds one distinct voter's vote
    const t0 = now();
    const seen = new Set();
    const done = new Promise((resolve) => {
      const waiter = (s, list) => {
        const item = list.find((x) => x.id === qid);
        if (item && item.votes >= expected && !seen.has(s.id)) {
          seen.add(s.id);
          delivery.push(now() - t0);
          if (seen.size === live.length) { waiters.delete(waiter); resolve(); }
        }
      };
      waiters.add(waiter);
      setTimeout(() => { waiters.delete(waiter); resolve(); }, 5000); // do not hang on lost messages
    });
    await api(`/api/rooms/${code}/questions/${qid}/vote`, 'POST', undefined, voterToken);
    await done;
  }
  summary('broadcast delivery', delivery);
  const expectedDeliveries = ROUNDS * live.length;
  console.log(`delivered ${delivery.length}/${expectedDeliveries} (${((delivery.length / expectedDeliveries) * 100).toFixed(1)}%)\n`);

  // ---- 3. same voter, parallel duplicates ----
  const before = await votesNow();
  const same = await newVoter();
  await Promise.all(Array.from({ length: 25 }, () => api(`/api/rooms/${code}/questions/${qid}/vote`, 'POST', undefined, same)));
  const afterDup = await votesNow();
  const dupOk = afterDup === before + 1;
  console.log(`duplicate-vote test: 25 parallel votes by one voter -> count ${before} -> ${afterDup}  ${dupOk ? 'PASS' : 'FAIL'}`);

  // ---- 4. burst of distinct voters ----
  const tokens = await Promise.all(Array.from({ length: BURST }, newVoter));
  const burstStart = now();
  const results = await Promise.allSettled(
    tokens.map((t) => api(`/api/rooms/${code}/questions/${qid}/vote`, 'POST', undefined, t))
  );
  const burstMs = now() - burstStart;
  const failed = results.filter((r) => r.status === 'rejected').length;
  const finalVotes = await votesNow();
  const burstOk = failed === 0 && finalVotes === afterDup + BURST;
  console.log(`burst test: ${BURST} distinct voters in ${burstMs.toFixed(0)}ms, failed ${failed}, final count ${finalVotes} (expected ${afterDup + BURST})  ${burstOk ? 'PASS' : 'FAIL'}`);

  // ---- 5. forged identity must be rejected ----
  let forgedOk = false;
  try {
    await api(`/api/rooms/${code}/questions/${qid}/vote`, 'POST', undefined, `${crypto.randomUUID()}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  } catch (err) {
    forgedOk = err.message.includes('401');
  }
  console.log(`forged-token test: invented voter id rejected  ${forgedOk ? 'PASS' : 'FAIL'}`);

  for (const s of live) s.close();
  process.exit(dupOk && burstOk && forgedOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test failed:', err.message);
  process.exit(2);
});
