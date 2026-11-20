export const API_BASE = import.meta.env.VITE_API_URL ?? '';

// ---------- anonymous identity ----------
// The server issues a signed voter token; "one vote per person per question" is keyed on
// it. It lives in this browser, so clearing site data gives a new identity. That is the
// known limit of anonymous voting (see README).
const IDENTITY_KEY = 'db_identity';
let identityPromise = null;

function readStoredIdentity() {
  try {
    const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null');
    return raw?.voterToken ? raw : null;
  } catch { return null; }
}

function getIdentity(forceNew = false) {
  if (forceNew) identityPromise = null;
  identityPromise ??= (async () => {
    const stored = forceNew ? null : readStoredIdentity();
    if (stored) return stored;
    const issued = await send('/api/voters', { method: 'POST' });
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(issued)); } catch { /* storage blocked: per-tab identity */ }
    return issued;
  })().catch((err) => { identityPromise = null; throw err; });
  return identityPromise;
}

export const getModToken = (code) => {
  try { return localStorage.getItem(`db_mod_${code}`) ?? ''; } catch { return ''; }
};
export const setModToken = (code, token) => {
  try { localStorage.setItem(`db_mod_${code}`, token); } catch { /* ignore */ }
};

async function send(path, { method = 'GET', body, modToken, voterToken } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(modToken ? { 'x-mod-token': modToken } : {}),
      ...(voterToken ? { 'x-voter-token': voterToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Requests that act as a voter. If the server rejects the token (for example it was
// restarted with a new VOTER_SECRET), get a fresh identity and retry once.
async function asVoter(path, opts = {}) {
  const { voterToken } = await getIdentity();
  try {
    return await send(path, { ...opts, voterToken });
  } catch (err) {
    if (err.status !== 401) throw err;
    const fresh = await getIdentity(true);
    return send(path, { ...opts, voterToken: fresh.voterToken });
  }
}

const q = (code, id = '') => `/api/rooms/${code}/questions${id ? `/${id}` : ''}`;

export const api = {
  createRoom: (title) => send('/api/rooms', { method: 'POST', body: { title } }),
  getRoom: (code) => send(`/api/rooms/${code}`),
  getQuestions: (code) => send(q(code)),
  getMyVotes: (code) => asVoter(`/api/rooms/${code}/my-votes`),
  similar: (code, text) => send(`/api/rooms/${code}/similar`, { method: 'POST', body: { text } }),
  ask: (code, text) => asVoter(q(code), { method: 'POST', body: { text } }),
  vote: (code, id) => asVoter(`${q(code, id)}/vote`, { method: 'POST' }),
  unvote: (code, id) => asVoter(`${q(code, id)}/vote`, { method: 'DELETE' }),
  merge: (code, id, targetId, modToken) => send(`${q(code, id)}/merge`, { method: 'POST', body: { targetId }, modToken }),
  unmerge: (code, id, modToken) => send(`${q(code, id)}/unmerge`, { method: 'POST', modToken }),
  remove: (code, id, modToken) => send(q(code, id), { method: 'DELETE', modToken }),
  setAnswered: (code, id, answered, modToken) => send(`${q(code, id)}/answered`, { method: 'POST', body: { answered }, modToken }),

  // Peer answers. Everything goes through asVoter so the server can tell "mine" and "asker";
  // the moderator key is sent too where it matters (delete / accept).
  getAnswers: (code, id) => asVoter(`${q(code, id)}/answers`),
  postAnswer: (code, id, text) => asVoter(`${q(code, id)}/answers`, { method: 'POST', body: { text } }),
  voteAnswer: (code, aid) => asVoter(`/api/rooms/${code}/answers/${aid}/vote`, { method: 'POST' }),
  unvoteAnswer: (code, aid) => asVoter(`/api/rooms/${code}/answers/${aid}/vote`, { method: 'DELETE' }),
  removeAnswer: (code, aid, modToken) => asVoter(`/api/rooms/${code}/answers/${aid}`, { method: 'DELETE', modToken }),
  accept: (code, id, answerId, modToken) => asVoter(`${q(code, id)}/accepted`, { method: 'POST', body: { answerId }, modToken }),
  clearAccepted: (code, id, modToken) => asVoter(`${q(code, id)}/accepted`, { method: 'DELETE', modToken }),
};