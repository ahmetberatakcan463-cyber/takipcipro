/**
 * ============================================================
 *  servisleri-cek.js
 *
 *  SosyalBizde API'sinden tüm servisleri çeker ve
 *  MongoDB'ye kaydeder (varsa günceller).
 *
 *  Çalıştırmak için:
 *    npm run servisleri-cek
 *  veya:
 *    node scripts/servisleri-cek.js
 * ============================================================
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios    = require('axios');
const mongoose = require('mongoose');
const Service  = require('../models/Service');

const SMMPANEL_URL = process.env.SMMPANEL_URL;
const SMMPANEL_KEY = process.env.SMMPANEL_KEY;
const MONGO_URI    = process.env.MONGO_URI || 'mongodb://localhost:27017/takipcipro';

/* ─── Renk yardımcısı (terminal çıktısı için) ─── */
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};
const log = {
  ok:   (m) => console.log(`${c.green}✓${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`),
  err:  (m) => console.log(`${c.red}✗${c.reset} ${m}`),
  info: (m) => console.log(`${c.cyan}→${c.reset} ${m}`),
  head: (m) => console.log(`\n${c.bold}${m}${c.reset}\n`),
};

/* ─── Instagram ile ilgili kategorileri filtrele ─── */
function isInstagram(kategori = '', ad = '') {
  const k = (kategori + ' ' + ad).toLowerCase();
  return k.includes('instagram') || k.includes('ig ') || k.includes('insta');
}

/* ─── Teslimat süresi tahmin et ─── */
function tahminTeslimat(min) {
  if (min <= 100)  return '5-15 dakika';
  if (min <= 500)  return '15-30 dakika';
  if (min <= 1000) return '30-60 dakika';
  if (min <= 2500) return '1-3 saat';
  return '2-6 saat';
}

async function main() {
  log.head('═══════════════════════════════════════════');
  log.head('  TakipçiPro — Servis Çekici');
  log.head('═══════════════════════════════════════════');

  if (!SMMPANEL_URL || !SMMPANEL_KEY) {
    log.err('.env dosyasında SMMPANEL_URL veya SMMPANEL_KEY eksik!');
    process.exit(1);
  }

  // 1) MongoDB'ye bağlan
  log.info('MongoDB bağlantısı kuruluyor...');
  await mongoose.connect(MONGO_URI);
  log.ok(`MongoDB bağlandı: ${MONGO_URI}`);

  // 2) API'den servisleri çek
  log.info('SosyalBizde\'den tüm servisler çekiliyor...');
  const body = new URLSearchParams({ key: SMMPANEL_KEY, action: 'services' });
  const { data: servisler } = await axios.post(SMMPANEL_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });

  if (!Array.isArray(servisler)) {
    log.err('API yanıtı beklenmeyen formatta: ' + JSON.stringify(servisler).slice(0,200));
    process.exit(1);
  }

  log.ok(`Toplam ${servisler.length} servis çekildi.`);

  // 3) Kategorilere göre özet göster
  const katMap = {};
  servisler.forEach(s => {
    const k = s.category || 'Diğer';
    katMap[k] = (katMap[k] || 0) + 1;
  });
  log.head('Kategori Dağılımı:');
  Object.entries(katMap)
    .sort((a,b) => b[1]-a[1])
    .slice(0, 15)
    .forEach(([k,v]) => log.info(`  ${k}: ${v} servis`));

  // 4) MongoDB'ye kaydet (upsert — varsa güncelle)
  log.head(`MongoDB'ye kaydediliyor...`);
  let eklenen = 0, guncellenen = 0, hatali = 0;

  for (const s of servisler) {
    try {
      const mevcutDoc = await Service.findOne({ servisId: Number(s.service) });

      const guncel = {
        servisId:   Number(s.service),
        kategori:   s.category    || '',
        orijinalAd: s.name        || '',
        fiyat:      parseFloat(s.rate) || 0,
        min:        parseInt(s.min)    || 10,
        max:        parseInt(s.max)    || 10000,
        tur:        s.type        || '',
        guncellendi: new Date(),
      };

      if (mevcutDoc) {
        // Mevcut kayıt — sadece API verilerini güncelle, admin ayarlarına dokunma
        await Service.updateOne({ servisId: guncel.servisId }, { $set: {
          kategori:   guncel.kategori,
          orijinalAd: guncel.orijinalAd,
          fiyat:      guncel.fiyat,
          min:        guncel.min,
          max:        guncel.max,
          tur:        guncel.tur,
          guncellendi: guncel.guncellendi,
        }});
        guncellenen++;
      } else {
        // Yeni kayıt — teslimat tahmini ekle
        await Service.create({
          ...guncel,
          vitrinAd:  '',
          teslimat:  tahminTeslimat(guncel.min),
          vitrin:    false,
          aktif:     true,
          populer:   false,
          sira:      999,
          musteriTL: 0,
          eskiFiyatTL: 0,
        });
        eklenen++;
      }
    } catch(e) {
      hatali++;
      if (hatali <= 3) log.warn(`Hata (Servis ${s.service}): ${e.message}`);
    }
  }

  log.ok(`Eklenen: ${eklenen} | Güncellenen: ${guncellenen} | Hatalı: ${hatali}`);

  // 5) Instagram servisleri özet
  const igCount = await Service.countDocuments({ kategori: /instagram/i });
  const vitrinCount = await Service.countDocuments({ vitrin: true });
  log.head('Özet:');
  log.ok(`Toplam veritabanı: ${await Service.countDocuments()} servis`);
  log.ok(`Instagram servisleri: ${igCount}`);
  log.ok(`Vitrine alınan: ${vitrinCount}`);

  if (vitrinCount === 0) {
    log.warn('Henüz vitrine alınan servis yok!');
    log.warn('Admin panelinden Servis Yönetimi\'ne gir ve en iyileri seç.');
  }

  await mongoose.disconnect();
  log.ok('\nBitti! Sunucuyu başlatabilirsin: node server.js\n');
}

main().catch(err => {
  log.err('Beklenmeyen hata: ' + err.message);
  console.error(err);
  process.exit(1);
});
