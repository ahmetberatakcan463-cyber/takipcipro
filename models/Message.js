const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true, maxlength: 64 },
  ad:        { type: String, default: 'Ziyaretçi', maxlength: 60 },
  icerik:    { type: String, required: true, maxlength: 1000 },
  gonderen:  { type: String, enum: ['musteri', 'admin'], default: 'musteri' },
  okundu:    { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);
