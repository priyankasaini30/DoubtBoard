import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { config, corsOrigin } from './config.js';
import { apiLimiter, voterIssueLimiter } from './middleware/limiters.js';
import { issueVoter } from './identity.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createBroadcaster, listQuestions } from './broadcast.js';
import { Room } from './models/Room.js';

const CODE_RE = /^[A-Z2-9]{6}$/;

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind one reverse proxy
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigin() }));
  app.use(express.json({ limit: '10kb' }));

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: corsOrigin() } });
  const broadcast = createBroadcaster(io);

  app.get('/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ ok: dbUp });
  });

  app.use('/api', apiLimiter);
  // Issues a signed anonymous identity. Needs no database.
  app.post('/api/voters', voterIssueLimiter, (_req, res) => res.status(201).json(issueVoter()));
  app.use('/api/rooms', createRoomsRouter({ broadcast }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  // ---------- sockets ----------
  // A socket only joins a room and listens. All writes go through REST, where they
  // are validated and rate limited. When a socket drops, the client reconnects,
  // re-emits room:join and receives the full current list in the ack, so nothing is lost.
  const presence = (code) => io.sockets.adapter.rooms.get(code)?.size ?? 0;

  io.on('connection', (socket) => {
    socket.on('room:join', async (rawCode, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const code = String(rawCode ?? '').toUpperCase();
        if (!CODE_RE.test(code) || !(await Room.exists({ code }))) return reply({ ok: false, error: 'Room not found.' });
        for (const r of socket.rooms) if (r !== socket.id) socket.leave(r); // one room per socket
        socket.join(code);
        socket.data.code = code;
        io.to(code).emit('presence', presence(code));
        reply({ ok: true, questions: await listQuestions(code), presence: presence(code) });
      } catch (err) {
        console.error('room:join failed', err.message);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    socket.on('disconnecting', () => {
      const code = socket.data.code;
      if (code) io.to(code).emit('presence', Math.max(0, presence(code) - 1));
    });
  });

  return { app, server, io };
}

export { config };
