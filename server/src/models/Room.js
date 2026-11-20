import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 80 },
  // Secret that unlocks moderator actions. Never returned except once, at creation.
  modToken: { type: String, required: true, select: false },
  createdAt: { type: Date, default: Date.now },
});

export const Room = mongoose.model('Room', roomSchema);