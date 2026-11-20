import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getModToken, setModToken } from './api.js';
import { useRoom } from './useRoom.js';

// ---------- tiny hash router: "#/" is home, "#/r/ABC123" is a room ----------
function useRoute() {
  const read = () => {
    const m = window.location.hash.match(/^#\/r\/([A-Za-z2-9]{6})\/?$/);
    return m ? m[1].toUpperCase() : null;
  };
  const [code, setCode] = useState(read);
  useEffect(() => {
    const on = () => setCode(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return code;
}

const go = (code) => { window.location.hash = code ? `#/r/${code}` : '#/'; };

function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------- home ----------
function Home() {
  const [title, setTitle] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const room = await api.createRoom(title);
      setModToken(room.code, room.modToken);
      go(room.code);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  function join(e) {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(c)) return setError('Room codes are 6 characters, e.g. K7M2QX.');
    go(c);
  }

  return (
    <main className="shell narrow">
      <header className="brand">
        <h1>Doubt<span>Board</span></h1>
        <p>Live Q&amp;A for any group: a lecture, workshop, webinar, meetup or study group. Ask, vote, and see the doubts everyone shares. Similar questions are suggested before you post, so the same doubt does not get asked ten times.</p>
      </header>

      <form className="card" onSubmit={join}>
        <h2>Join a session</h2>
        <div className="row">
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Room code" maxLength={6} className="code-input" autoCapitalize="characters" />
          <button className="btn primary" type="submit">Join</button>
        </div>
      </form>

      <form className="card" onSubmit={create}>
        <h2>Start a session</h2>
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Workshop Q&A, or OS Unit 3 doubts" maxLength={80} />
          <button className="btn" type="submit" disabled={busy || title.trim().length < 3}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
        <p className="hint">You get a moderator key in this browser. Share the room code with everyone who should join.</p>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

// ---------- ask box with live duplicate suggestions ----------
function AskBox({ code, myVotes, onVote, onError }) {
  const [text, setText] = useState('');
  const [similar, setSimilar] = useState([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const t = text.trim();
    if (t.length < 5) { setSimilar([]); return undefined; }
    const mySeq = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api.similar(code, t);
        if (mySeq === seq.current) setSimilar(res.similar); // ignore out-of-order responses
      } catch { /* suggestions are optional */ }
    }, 350);
    return () => clearTimeout(timer);
  }, [text, code]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.ask(code, text.trim());
      setText(''); setSimilar([]);
    } catch (err) { onError(err.message); }
    setBusy(false);
  }

  async function upvoteInstead(id) {
    if (!myVotes.has(id)) await onVote(id);
    setText(''); setSimilar([]);
  }

  return (
    <form className="card ask" onSubmit={submit}>
      <label htmlFor="ask" className="sr">Your question</label>
      <textarea id="ask" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={300} placeholder="What is your doubt?" />
      {similar.length > 0 && (
        <div className="similar" role="status">
          <strong>Similar question{similar.length > 1 ? 's' : ''} already asked. Is it the same doubt?</strong>
          <ul>
            {similar.map((s) => (
              <li key={s.id}>
                <span>{s.text} <em>({s.votes} vote{s.votes === 1 ? '' : 's'})</em></span>
                <button type="button" className="btn small" onClick={() => upvoteInstead(s.id)} disabled={myVotes.has(s.id)}>
                  {myVotes.has(s.id) ? 'Voted' : 'Upvote this'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row between">
        <span className="hint">{text.length}/300</span>
        <button className="btn primary" type="submit" disabled={busy || text.trim().length < 5}>
          {similar.length ? 'Post anyway' : 'Post question'}
        </button>
      </div>
    </form>
  );
}

// Removing is permanent, so always ask first.
const confirmRemove = (text) => window.confirm(`Remove this question for everyone?\n\n"${text.slice(0, 120)}"`);

// ---------- answers under one question ----------
// Fetches its own list; `tick` changes whenever the server says this question's answers changed.
function AnswersPanel({ q, code, tick, mod, modToken, onError }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const res = await api.getAnswers(code, q.id);
      if (mySeq === seq.current) setData(res); // ignore out-of-order responses
    } catch (e) { onError(e.message); }
  }, [code, q.id, onError]);

  useEffect(() => { load(); }, [load, tick]);

  const act = async (fn) => { try { await fn(); await load(); } catch (e) { onError(e.message); } };
  const canAccept = Boolean(data?.canAccept) || mod;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.postAnswer(code, q.id, text.trim());
      setText('');
      await load();
    } catch (err) { onError(err.message); }
    setBusy(false);
  }

  const answers = data?.answers ?? [];
  return (
    <div className="answers">
      {data === null && <p className="hint">Loading answers…</p>}
      {data && answers.length === 0 && <p className="hint">No answers yet. Know it? Help out below.</p>}
      <ul>
        {answers.map((a) => (
          <li key={a.id} className={`answer ${a.accepted ? 'accepted' : ''}`}>
            <button
              className={`vote small ${a.voted ? 'on' : ''}`}
              disabled={a.mine}
              aria-pressed={a.voted}
              aria-label={a.mine ? 'Your own answer' : a.voted ? 'Remove your vote' : 'Vote for this answer'}
              title={a.mine ? 'You cannot vote on your own answer' : undefined}
              onClick={() => act(() => (a.voted ? api.unvoteAnswer(code, a.id) : api.voteAnswer(code, a.id)))}
            >
              <span aria-hidden="true">▲</span>
              <b>{a.votes}</b>
            </button>
            <div className="body">
              <p className="text">{a.text}</p>
              <div className="meta">
                <span>{ago(a.createdAt)}</span>
                {a.accepted && <span className="badge good">✓ Accepted</span>}
                {a.mine && <span className="badge">You</span>}
                {a.fromMerged && <span className="hint">from a merged question</span>}
                {canAccept && !a.fromMerged && !data.merged && (
                  <button
                    className="link"
                    onClick={() => act(() => (a.accepted ? api.clearAccepted(code, q.id, modToken) : api.accept(code, q.id, a.id, modToken)))}
                  >
                    {a.accepted ? 'Unaccept' : 'Accept'}
                  </button>
                )}
                {(a.mine || mod) && (
                  <button
                    className="link"
                    onClick={() => window.confirm('Delete this answer?') && act(() => api.removeAnswer(code, a.id, modToken))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form className="answer-form" onSubmit={submit}>
        <label htmlFor={`ans-${q.id}`} className="sr">Your answer</label>
        <textarea id={`ans-${q.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} placeholder="Write an answer…" />
        <div className="row between">
          <span className="hint">{text.length}/1000</span>
          <button className="btn small primary" type="submit" disabled={busy || text.trim().length < 3}>Post answer</button>
        </div>
      </form>
    </div>
  );
}

// ---------- one question ----------
function QuestionCard({ q, voted, onVote, mod, others, code, modToken, onError, tick }) {
  const [showMerged, setShowMerged] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const act = async (fn) => { try { await fn(); } catch (e) { onError(e.message); } };

  return (
    <li className={`card q ${q.status === 'answered' ? 'answered' : ''}`}>
      <button className={`vote ${voted ? 'on' : ''}`} onClick={() => onVote(q.id)} aria-pressed={voted} aria-label={voted ? 'Remove your vote' : 'Vote for this question'}>
        <span aria-hidden="true">▲</span>
        <b>{q.votes}</b>
      </button>
      <div className="body">
        <p className="text">{q.text}</p>
        <div className="meta">
          <span>{ago(q.createdAt)}</span>
          {q.solved ? <span className="badge good">✓ Solved</span> : q.status === 'answered' && <span className="badge">Answered</span>}
          <button className="link" onClick={() => setShowAnswers((s) => !s)} aria-expanded={showAnswers}>
            {q.answerCount > 0 ? `${q.answerCount} answer${q.answerCount === 1 ? '' : 's'}` : 'Answer'} {showAnswers ? '▾' : '▸'}
          </button>
          {q.merged.length > 0 && (
            <button className="link" onClick={() => setShowMerged((s) => !s)}>
              {q.merged.length} similar merged {showMerged ? '▾' : '▸'}
            </button>
          )}
        </div>
        {showAnswers && <AnswersPanel q={q} code={code} tick={tick} mod={mod} modToken={modToken} onError={onError} />}
        {showMerged && (
          <ul className="merged">
            {q.merged.map((m) => (
              <li key={m.id}>
                <span>{m.text}</span>
                {mod && (
                  <span className="row">
                    <button className="btn small" onClick={() => act(() => api.unmerge(code, m.id, modToken))}>Split out</button>
                    <button className="btn small" onClick={() => confirmRemove(m.text) && act(() => api.remove(code, m.id, modToken))}>Remove</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {mod && (
          <div className="mod">
            <button className="btn small" onClick={() => act(() => api.setAnswered(code, q.id, q.status !== 'answered', modToken))}>
              {q.status === 'answered' ? 'Reopen' : 'Mark answered'}
            </button>
            <button className="btn small" onClick={() => confirmRemove(q.text) && act(() => api.remove(code, q.id, modToken))}>
              Remove
            </button>
            {others.length > 0 && (
              <select value="" onChange={(e) => e.target.value && act(() => api.merge(code, q.id, e.target.value, modToken))} aria-label="Merge into another question">
                <option value="">Merge into…</option>
                {others.map((o) => <option key={o.id} value={o.id}>{o.text.slice(0, 60)}</option>)}
              </select>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ---------- room ----------
function RoomPage({ code }) {
  const { room, questions, myVotes, connected, presence, error, setError, toggleVote, answerTicks } = useRoom(code);
  const [modToken, setToken] = useState(() => getModToken(code));
  const [keyInput, setKeyInput] = useState('');
  const [askingKey, setAskingKey] = useState(false);
  const mod = Boolean(modToken);

  useEffect(() => { setToken(getModToken(code)); }, [code]);
  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(''), 5000);
    return () => clearTimeout(t);
  }, [error, setError]);

  function saveKey(e) {
    e.preventDefault();
    const k = keyInput.trim();
    if (!k) return;
    setModToken(code, k); setToken(k); setAskingKey(false); setKeyInput('');
  }

  const share = () => navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}#/r/${code}`);

  if (error && !room) {
    return (
      <main className="shell narrow">
        <p className="error" role="alert">{error}</p>
        <button className="btn" onClick={() => go(null)}>Back</button>
      </main>
    );
  }

  const openQuestions = questions.filter((q) => q.status !== 'answered');

  return (
    <main className="shell">
      <header className="room-head">
        <div>
          <button className="link" onClick={() => go(null)}>← DoubtBoard</button>
          <h1>{room?.title ?? 'Loading…'}</h1>
        </div>
        <div className="head-right">
          <span className="code" title="Room code">{code}</span>
          <button className="btn small" onClick={share}>Copy link</button>
          <span className={`dot ${connected ? 'live' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} />
          <span className="hint">{connected ? `${presence} here` : 'reconnecting…'}</span>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <AskBox code={code} myVotes={myVotes} onVote={toggleVote} onError={setError} />

      <section aria-label="Questions">
        {questions.length === 0 ? (
          <p className="empty">No questions yet. Be the first to ask.</p>
        ) : (
          <ol className="list">
            {questions.map((q) => (
              <QuestionCard
                key={q.id} q={q} code={code}
                voted={myVotes.has(q.id)} onVote={toggleVote}
                mod={mod} modToken={modToken}
                others={openQuestions.filter((o) => o.id !== q.id)}
                onError={setError}
                tick={(answerTicks.all ?? 0) + (answerTicks[q.id] ?? 0)}
              />
            ))}
          </ol>
        )}
      </section>

      <footer className="foot">
        {mod ? (
          <>
            <span className="badge">Moderator</span>
            <button className="link" onClick={() => navigator.clipboard?.writeText(modToken)}>Copy moderator key</button>
          </>
        ) : askingKey ? (
          <form className="row" onSubmit={saveKey}>
            <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Moderator key" autoFocus />
            <button className="btn small" type="submit">Unlock</button>
          </form>
        ) : (
          <button className="link" onClick={() => setAskingKey(true)}>I'm the moderator</button>
        )}
      </footer>
    </main>
  );
}

export default function App() {
  const code = useRoute();
  return code ? <RoomPage key={code} code={code} /> : <Home />;
}