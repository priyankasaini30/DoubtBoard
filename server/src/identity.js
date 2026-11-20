// Anonymous but unforgeable voter identity.
//
// The server issues each browser a random voterId plus an HMAC signature over it.
// Every write request must carry that token, so a client cannot invent voter ids
// (e.g. a curl loop with random ids) to stuff votes past the unique index.
//
// Known limit, stated honestly in the README: this is one identity per browser, not
// per human. Clearing site data gives a new identity, and the per-IP limit on issuing
// identities is what slows scripted abuse down.
import crypto from 'node:crypto';
import { config } from './config.js';

const sign = (voterId) => crypto.createHmac('sha256', config.voterSecret).update(voterId).digest('base64url');

export function issueVoter() {
  const voterId = crypto.randomUUID();
  return { voterId, voterToken: `${voterId}.${sign(voterId)}` };
}

// Returns the voterId if the token is authentic, otherwise null.
export function verifyVoterToken(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const voterId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(voterId));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return voterId;
}
