const mongoose = require('mongoose');

/**
 * Servis Modeli
 * SosyalBizde'den çekilen her hizmet bir "Service" belgesi olarak saklanır.
 * Admin hangi servisleri vitrine koyacağını, adını ve açıklamasını buradan yönetir.
 */
const ServiceSchema = new mongoose.Schema({

  // ─── SosyalBizde'den gelen ham veriler ───
  servisId:    { type: Number, required: true, unique: true }, // API servis ID'si
  kategori:    { type: String, default: '' },                  // Örn: "Instagram"
  orijinalAd:  { type: String, default: '' },                  // API'den gelen ham isim
  fiyat:       { type: Number, default: 0 },                   // 1000 adet fiyatı ($)
  min:         { type: Number, default: 10 },                  // Minimum sipariş
  max:         { type: Number, default: 10000 },               // Maksimum sipariş
  tur:         { type: String, default: '' },                  // Default, Custom, vb.

  // ─── Admin tarafından düzenlenen veriler ───
  vitrinAd:    { type: String, default: '' },    // Müşteriye gösterilen isim
  aciklama:    { type: String, default: '' },    // Kart altı açıklama
  emoji:       { type: String, default: '⭐' }, // Paket emojisi
  teslimat:    { type: String, default: '' },    // Örn: "15-30 dakika"

  // ─── Görünürlük & Yönetim ───
  vitrin:      { type: Boolean, default: false }, // Sitede gösterilsin mi?
  aktif:       { type: Boolean, default: true  }, // Servis şu an çalışıyor mu?
  populer:     { type: Boolean, default: false }, // "En Popüler" rozeti?
  sira:        { type: Number,  default: 999  },  // Vitrin sırası (küçük = önce)

  // ─── Fiyatlandırma (müşteriye) ───
  // Kâr marjı eklenmiş TL fiyatı (admin belirler)
  musteriTL:   { type: Number, default: 0 },
  eskiFiyatTL: { type: Number, default: 0 },   // Üstü çizili eski fiyat (0 = gösterme)

  // ─── Metadata ───
  ilkEkleme:   { type: Date, default: Date.now },
  guncellendi: { type: Date, default: Date.now },

}, { timestamps: false });

// Güncelleme tarihini otomatik güncelle
ServiceSchema.pre('save', function(next) {
  this.guncellendi = new Date();
  next();
});

// Vitrin için optimize index
ServiceSchema.index({ vitrin: 1, aktif: 1, sira: 1 });
ServiceSchema.index({ kategori: 1 });

module.exports = mongoose.model('Service', ServiceSchema);
