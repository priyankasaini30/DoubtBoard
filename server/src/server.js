import mongoose from 'mongoose';
import { createApp, config } from './app.js';
import { Room } from './models/Room.js';
import { Question } from './models/Question.js';
import { Vote } from './models/Vote.js';
import { Answer } from './models/Answer.js';
import { AnswerVote } from './models/AnswerVote.js';

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  // Make sure the unique indexes exist before accepting traffic. The vote-integrity
  // guarantee depends on the Vote index, so do not skip this in production.
  await Promise.all([Room.init(), Question.init(), Vote.init(), Answer.init(), AnswerVote.init()]);
  console.log('MongoDB connected');
  if (config.voterSecretIsEphemeral) {
    console.warn('VOTER_SECRET is not set: voter tokens are signed with a random key and reset on every restart. Set it in production.');
  }

  const { server, io } = createApp();
  server.listen(config.port, () => console.log(`DoubtBoard API listening on :${config.port}`));

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    io.close();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});