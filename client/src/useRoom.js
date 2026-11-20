import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE, api } from './api.js';

// One hook owns the live state of a room: the ranked list, this user's votes,
// connection status and presence. Writes go over REST; the socket only receives.
export function useRoom(code) {
  const [room, setRoom] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [myVotes, setMyVotes] = useState(() => new Set());
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState(0);
  const [error, setError] = useState('');
  // Bumped when a question's answers change (or after a reconnect), so open answer panels re-fetch.
  const [answerTicks, setAnswerTicks] = useState({ all: 0 });
  const socketRef = useRef(null);

  const refreshVotes = useCallback(async () => {
    try {
      const { questionIds } = await api.getMyVotes(code);
      setMyVotes(new Set(questionIds));
    } catch { /* non-fatal: buttons just start unhighlighted */ }
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    setRoom(null); setQuestions([]); setError(''); setConnected(false);

    api.getRoom(code)
      .then((r) => { if (!cancelled) setRoom(r); })
      .catch((e) => { if (!cancelled) setError(e.status === 404 ? 'Room not found. Check the code.' : e.message); });

    const socket = io(API_BASE || undefined, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    // Runs on first connect AND on every reconnect, so a dropped connection
    // always ends with a full re-sync instead of a stale screen.
    socket.on('connect', () => {
      setConnected(true);
      setAnswerTicks((t) => ({ ...t, all: t.all + 1 }));
      socket.emit('room:join', code, (ack) => {
        if (cancelled) return;
        if (ack?.ok) {
          setQuestions(ack.questions);
          setPresence(ack.presence);
          refreshVotes();
        } else setError(ack?.error ?? 'Could not join the room.');
      });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('questions', (list) => setQuestions(list));
    socket.on('presence', (n) => setPresence(n));
    socket.on('answers:changed', ({ questionIds }) => {
      setAnswerTicks((t) => {
        const next = { ...t };
        for (const id of questionIds ?? []) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
    });

    // Ranking depends on age, which changes without any event. Re-fetch once a minute.
    const timer = setInterval(() => {
      api.getQuestions(code).then((r) => !cancelled && setQuestions(r.questions)).catch(() => {});
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      socket.close();
    };
  }, [code, refreshVotes]);

  // Optimistic vote toggle: update the UI at once, roll back if the server refuses.
  const toggleVote = useCallback(async (id) => {
    const had = myVotes.has(id);
    const flip = (on) => setMyVotes((prev) => {
      const next = new Set(prev);
      on ? next.add(id) : next.delete(id);
      return next;
    });
    flip(!had);
    try {
      await (had ? api.unvote(code, id) : api.vote(code, id));
    } catch (e) {
      flip(had);
      setError(e.message);
    }
  }, [code, myVotes]);

  return { room, questions, myVotes, connected, presence, error, setError, toggleVote, answerTicks };
}