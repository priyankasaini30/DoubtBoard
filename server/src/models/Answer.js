import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Never sent to clients: they only learn whether an answer is theirs ("mine").
  authorId: { type: String, required: true },
  text: { type: String, required: true, trim: true, minlength: 3, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
});

answerSchema.index({ roomCode: 1, questionId: 1, createdAt: 1 });

export const Answer = mongoose.model('Answer', answerSchema);