const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  serviceId:   { type: Number, required: true, index: true },
  username:    { type: String, required: true, trim: true },
  quantity:    { type: Number, required: true },
  smmOrderId:  { type: String, default: null, index: true },
  status:      { type: String, enum: ['success', 'pending', 'error', 'beklemede', 'iban_hazir', 'shopier_bekliyor'], required: true },
  smmResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
  error:       { type: String, default: null },
}, { timestamps: true, collection: 'orders' });

module.exports = mongoose.model('Order', OrderSchema);
