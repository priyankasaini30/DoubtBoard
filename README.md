
# DoubtBoard

A real-time Q&A platform for lectures, workshops, webinars, and study groups. Participants join using a room code, ask questions, vote, and share answers. The platform suggests similar existing questions to reduce duplicates.

## Features

- Create and join rooms using unique room codes.
- Real-time question updates using Socket.io.
- Suggest similar questions while typing.
- Vote on questions and answers.
- Rank questions using votes and time decay.
- Moderator controls to merge, split, delete, and resolve questions.
- Anonymous participation using server-signed voter tokens.

## Tech Stack

- **Frontend:** React, Vite
- **Backend:** Node.js, Express.js
- **Database:** MongoDB, Mongoose
- **Real-time:** Socket.io
- **Similarity Engine:** JavaScript, TF-IDF, Cosine Similarity

## How It Works

DoubtBoard uses a custom TF-IDF cosine similarity algorithm to identify potentially duplicate questions.

- Similar questions are suggested while typing.
- Users can upvote existing questions or post new ones.
- Questions are ranked using a time-decayed voting algorithm.
- MongoDB unique indexes prevent duplicate votes.
- Socket.io broadcasts real-time updates to room participants.

The similarity engine is implemented from scratch without external ML libraries or AI APIs.

## Installation

**Prerequisites:** Node.js 18+ and MongoDB.

```bash
npm run install:all
cp server/.env.example server/.env
```

Configure `MONGO_URI` and `VOTER_SECRET` in `server/.env`.

Start the backend:

```bash
npm run dev:server
```

Start the frontend in another terminal:

```bash
npm run dev:client
```

Open http://localhost:5173.

## Testing

```bash
npm test
npm run eval
```

For database integration tests, configure `MONGO_TEST_URI` with a disposable test database.

## Deployment

- **Backend:** Render / Railway
- **Frontend:** Vercel / Netlify
- **Database:** MongoDB Atlas

Configure `CLIENT_ORIGIN`, `MONGO_URI`, `VOTER_SECRET`, and `VITE_API_URL` for deployment.

## Known Limitations

- Anonymous identity is browser-based, not account-based.
- TF-IDF may not recognize synonyms and abbreviations.
- Rate limiting is currently in-memory.
- Multi-server deployment requires shared Socket.io and rate-limit infrastructure.

## Future Improvements

- Host authentication and room management.
- Semantic similarity improvements.
- Redis-based rate limiting and Socket.io scaling.
- Automatic room expiration.
