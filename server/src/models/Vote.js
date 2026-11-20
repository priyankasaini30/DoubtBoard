import mongoose from 'mongoose';

const voteSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  voterId: { type: String, required: true },
  // Remembers where a vote came from if a moderator moved it during a merge,
  // so an un-merge can put it back.
  originQuestionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: Date.now },
});

// The vote-integrity guarantee: one vote per voter per question, enforced by the database.
// Retries, double clicks and parallel requests cannot create a second document.
voteSchema.index({ roomCode: 1, questionId: 1, voterId: 1 }, { unique: true });
voteSchema.index({ roomCode: 1, voterId: 1 });
voteSchema.index({ questionId: 1, originQuestionId: 1 });

export const Vote = mongoose.model('Vote', voteSchema);
