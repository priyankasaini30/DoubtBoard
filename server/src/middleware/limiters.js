import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Per-IP limiter for the whole API.
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.apiRequestsPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

// Per-IP limiter for creating rooms.
export const roomCreateLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: config.roomsPerHour,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many rooms created from this address.' },
});

// Per-IP limiter for issuing anonymous voter identities.
export const voterIssueLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: config.votersPerHour,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many new identities from this address.' },
});

// Sliding-window limiter keyed by an arbitrary string (here: room + voter).
// In-memory, so it is per server process. With several servers, move it to Redis.
export class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs).unref();
  }

  // Returns true if the action is allowed (and records it), false if over the limit.
  take(key, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const recent = arr.filter((t) => now - t < this.windowMs);
      if (recent.length) this.hits.set(k, recent);
      else this.hits.delete(k);
    }
  }
}
