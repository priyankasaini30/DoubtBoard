import mongoose from 'mongoose';

const answerVoteSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  answerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  voterId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// Same guarantee as question votes: one vote per voter per answer, enforced by the database.
answerVoteSchema.index({ roomCode: 1, answerId: 1, voterId: 1 }, { unique: true });
answerVoteSchema.index({ roomCode: 1, voterId: 1 });

export const AnswerVote = mongoose.model('AnswerVote', answerVoteSchema);