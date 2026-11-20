import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  text: { type: String, required: true, trim: true, minlength: 5, maxlength: 300 },
  authorId: { type: String, required: true },
  status: { type: String, enum: ['open', 'answered'], default: 'open' },
  // The answer the asker (or the moderator) accepted. Accepting also marks the question answered.
  acceptedAnswerId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Set when a moderator merges this question into another one.
  mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
  createdAt: { type: Date, default: Date.now },
});

questionSchema.index({ roomCode: 1, mergedInto: 1, createdAt: -1 });
questionSchema.index({ mergedInto: 1 });

export const Question = mongoose.model('Question', questionSchema);