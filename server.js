/**
 * ============================================================
 *  TakipçiPro — Otomatik Sipariş + Servis Yönetimi (v2)
 *
 *  Akış:
 *  SosyalBizde → MongoDB → Admin Panel → Vitrin → Müşteri
 *  Müşteri → Sipariş → server.js → SosyalBizde API (otomatik)
 * ============================================================
 */

require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const mongoose   = require('mongoose');
const fs         = require('fs');
const path       = require('path');
const Service    = require('./models/Service');
const Order      = require('./models/Order');

const app  = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/takipcipro';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8543277332:AAGAKVT0P_WNIk1r1WXVHZaSWvUi6nrTATY7';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1951697589';

/* ─────────────────────────────────────────────────────
   MONGODB BAĞLANTISI
───────────────────────────────────────────────────── */
mongoose.connect(MONGO_URI)
  .then(() => console.log('[DB] MongoDB bağlandı ✓'))
  .catch(e  => console.error('[DB] MongoDB HATA:', e.message));

mongoose.connection.on('disconnected', () => console.warn('[DB] MongoDB bağlantısı kesildi!'));

/* ─────────────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────────────── */
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.use(cors({
  origin(origin, cb) {
    const izinli = [
      process.env.FRONTEND_URL,
      'https://takipcipro.netlify.app',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
    ].filter(Boolean);
    if (!origin || izinli.includes(origin)) return cb(null, true);
    console.warn(`[CORS RED] ${origin}`);
    cb(new Error('CORS: Bu kaynaktan istek kabul edilmiyor.'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-api-key'],
}));

// Genel rate limit — saatte 60 istek
app.use('/api/', rateLimit({
  windowMs: 60*60*1000, max: 60,
  message: { success:false, error:'Çok fazla istek. 1 saat bekleyin.' },
}));

// Sipariş endpointi — daha katı limit (saatte 10)
const siparisSiniri = rateLimit({
  windowMs: 60*60*1000, max: 10,
  message: { success:false, error:'Çok fazla sipariş girişimi.' },
});

/* ─────────────────────────────────────────────────────
   YARDIMCILAR
───────────────────────────────────────────────────── */

// API Key kontrolü (tüm /api/admin/* rotalarında)
function adminGuard(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
    console.warn(`[YETKİSİZ] IP: ${req.ip}`);
    return res.status(401).json({ success:false, error:'Yetkisiz.' });
  }
  next();
}

// Input temizle
function clean(str, maxLen=300) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'`\\]/g,'').slice(0, maxLen);
}

// SMM Panel çağrısı
async function smmCall(params) {
  if (!process.env.SMMPANEL_URL || !process.env.SMMPANEL_KEY) {
    throw new Error('SMMPANEL_URL veya SMMPANEL_KEY tanımlı değil.');
  }
  const body = new URLSearchParams({ key: process.env.SMMPANEL_KEY, ...params });
  const { data } = await axios.post(process.env.SMMPANEL_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return data;
}

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    }, { timeout: 10000 });
  } catch (e) {
    console.warn('[TELEGRAM] Bildirim gönderilemedi:', e.message);
  }
}

// Sipariş log dosyası
const LOG_FILE = path.join(__dirname, 'orders_log.json');
function readLog()   { try { return JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e){ return []; } }
function writeLog(d) { try { fs.writeFileSync(LOG_FILE, JSON.stringify(d.slice(0,500), null,2)); } catch(e){} }

/* ─────────────────────────────────────────────────────
   PUBLIC ENDPOINTLERİ (Netlify sitesi için)
───────────────────────────────────────────────────── */

/**
 * GET /api/vitrin
 * Vitrine alınmış servisleri döner — Netlify bu endpointi çağırır.
 */
app.get('/api/vitrin', async (req, res) => {
  try {
    const servisler = await Service.find({ vitrin:true, aktif:true })
      .select('servisId vitrinAd aciklama emoji teslimat populer sira musteriTL eskiFiyatTL min max')
      .sort({ sira: 1 })
      .lean();

    const paketler = servisler.map(s => ({
      id:        s.servisId,
      name:      s.vitrinAd   || '',
      emoji:     s.emoji      || '⭐',
      price:     s.musteriTL,
      oldPrice:  s.eskiFiyatTL > 0 ? s.eskiFiyatTL : null,
      delivery:  s.teslimat   || '15-30 dakika',
      popular:   s.populer    || false,
      aciklama:  s.aciklama   || '',
      min:       s.min,
      max:       s.max,
    }));

    res.json({ success:true, data: paketler });
  } catch(e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

/**
 * POST /api/siparis-ver
 * Frontend'den gelen siparişi alır ve SMM panele iletir.
 * Body: { serviceId, username, quantity }
 */
app.post('/api/siparis-ver', siparisSiniri, async (req, res) => {
  const serviceId = Number(req.body.serviceId ?? req.body.servisId);
  const quantity = Number(req.body.quantity ?? req.body.miktar);
  const usernameRaw = req.body.username ?? req.body.igKullanici;

  // Doğrulama
  if (!usernameRaw || !serviceId || !quantity) {
    return res.status(400).json({ success:false, error:'Eksik: serviceId, username, quantity' });
  }

  const username = clean(String(usernameRaw), 300);
  if (username.length < 2) {
    return res.status(400).json({ success:false, error:'Geçersiz username.' });
  }

  // Servis bilgisini al (bakiye hesabı için, yoksa devam et)
  const servis = await Service.findOne({ servisId: serviceId }).catch(() => null);

  console.log(`[SİPARİŞ] @${username} → ${quantity} adet (Servis: ${serviceId})`);

  // Manuel servisler (negatif ID) SMM'e gönderilmez, beklemede kaydedilir
  if (serviceId < 0) {
    await Order.create({ serviceId, username, quantity, status: 'manuel', smmResponse: {} });
    const logs = readLog();
    logs.unshift({ tarih:new Date().toISOString(), igKullanici:username,
      miktar:quantity, servisId:serviceId, durum:'manuel' });
    writeLog(logs);
    return res.json({ success:true, message:'Siparişiniz alındı! En kısa sürede teslim edilecek.' });
  }

  try {
    // Sipariş öncesi bakiye kontrolü
    const balanceData = await smmCall({ action: 'balance' });
    const smmBalance = Number.parseFloat(balanceData.balance || '0');
    const serviceRate = Number.parseFloat(servis?.fiyat || '0'); // 1000 adet fiyat
    const estimatedCost = (serviceRate / 1000) * quantity;

    if (Number.isFinite(smmBalance) && Number.isFinite(estimatedCost) && smmBalance < estimatedCost) {
      const warnMsg =
`⚠️ BAKIYE YETERSIZ!
Musteri siparis bekliyor.
Servis ID: ${serviceId}
Hedef: ${username}
Miktar: ${quantity}
Tahmini Maliyet: ${estimatedCost.toFixed(4)}
Mevcut Bakiye: ${smmBalance.toFixed(4)}
Lutfen hesabiniza bakiye yukleyin.`;

      await sendTelegramAlert(warnMsg);

      await Order.create({
        serviceId,
        username,
        quantity,
        status: 'pending',
        error: 'Insufficient SMM balance',
        smmResponse: {
          balance: smmBalance,
          estimatedCost,
        },
      });

      return res.status(202).json({
        success: false,
        status: 'beklemede',
        error: 'Bakiye yetersiz. Siparis beklemeye alindi.',
      });
    }

    const apiData = await smmCall({
      action: 'add',
      service: serviceId,
      link: username,
      quantity: quantity,
    });

    if (apiData.error) {
      await Order.create({
        serviceId,
        username,
        quantity,
        status: 'error',
        error: String(apiData.error),
        smmResponse: apiData,
      });
      return res.status(400).json({ success:false, error:String(apiData.error) });
    }

    if (!apiData.order) {
      await Order.create({
        serviceId,
        username,
        quantity,
        status: 'error',
        error: 'SMM panel order ID döndürmedi.',
        smmResponse: apiData,
      });
      return res.status(502).json({ success:false, error:'SMM panelden geçersiz yanıt alındı.' });
    }

    await Order.create({
      serviceId,
      username,
      quantity,
      smmOrderId: String(apiData.order),
      status: 'success',
      smmResponse: apiData,
    });

    // Log
    const logs = readLog();
    logs.unshift({ tarih:new Date().toISOString(), igKullanici:username,
      miktar:quantity, servisId:serviceId,
      smmOrderId:apiData.order||null, durum:'iletildi', ip:req.ip });
    writeLog(logs);

    return res.json({ success:true, smmOrderId:apiData.order, message:'SMM panele iletildi!' });
  } catch(err) {
    console.error(`[HATA siparis] ${err.message}`);
    await Order.create({
      serviceId,
      username,
      quantity,
      status: 'error',
      error: err.message,
      smmResponse: {},
    });
    const logs = readLog();
    logs.unshift({ tarih:new Date().toISOString(), igKullanici:username,
      miktar:quantity, servisId:serviceId, durum:'hata', hata:err.message });
    writeLog(logs);
    return res.status(500).json({ success:false, error:'SMM hatası: '+err.message });
  }
});

/**
 * GET /api/durum/:smmOrderId
 * Sipariş durumu sorgula.
 */
app.get('/api/durum/:smmOrderId', adminGuard, async (req, res) => {
  const id = req.params.smmOrderId.replace(/\D/g,'');
  if (!id) return res.status(400).json({ success:false, error:'Geçersiz ID.' });
  try {
    const data = await smmCall({ action:'status', order:id });
    res.json({ success:true, data });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

/**
 * GET /api/bakiye
 */
app.get('/api/bakiye', adminGuard, async (req, res) => {
  try {
    const data = await smmCall({ action:'balance' });
    res.json({ success:true, data });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ─────────────────────────────────────────────────────
   ADMIN ENDPOINTLERİ (/api/admin/*)
───────────────────────────────────────────────────── */

/**
 * GET /api/admin/servisler
 * Tüm servisleri sayfalı döner. Filter: kategori, vitrin, ara
 */
app.get('/api/admin/servisler', adminGuard, async (req, res) => {
  const { sayfa=1, limit=50, kategori, vitrin, ara } = req.query;
  const filtre = {};
  if (kategori) filtre.kategori = new RegExp(kategori, 'i');
  if (vitrin !== undefined) filtre.vitrin = vitrin === 'true';
  if (ara) filtre.$or = [
    { orijinalAd: new RegExp(ara, 'i') },
    { vitrinAd:   new RegExp(ara, 'i') },
  ];

  const toplam   = await Service.countDocuments(filtre);
  const servisler = await Service.find(filtre)
    .sort({ vitrin:-1, sira:1, servisId:1 })
    .skip((Number(sayfa)-1)*Number(limit))
    .limit(Number(limit))
    .lean();

  const kategoriler = await Service.distinct('kategori');

  res.json({ success:true, toplam, sayfa:Number(sayfa), servisler, kategoriler });
});

/**
 * PUT /api/admin/servis/:servisId
 * Tek bir servisi düzenle (vitrinAd, vitrin, populer, musteriTL, vb.)
 */
app.put('/api/admin/servis/:servisId', adminGuard, async (req, res) => {
  const { servisId } = req.params;
  const izinliAlanlar = ['vitrinAd','aciklama','emoji','teslimat','vitrin','aktif',
    'populer','sira','musteriTL','eskiFiyatTL'];

  const guncelleme = {};
  izinliAlanlar.forEach(alan => {
    if (req.body[alan] !== undefined) guncelleme[alan] = req.body[alan];
  });
  guncelleme.guncellendi = new Date();

  // Yalnızca bir servis "populer" olabilir
  if (guncelleme.populer === true) {
    await Service.updateMany({ servisId: { $ne: Number(servisId) } }, { populer:false });
  }

  const guncel = await Service.findOneAndUpdate(
    { servisId: Number(servisId) },
    { $set: guncelleme },
    { new:true }
  );
  if (!guncel) return res.status(404).json({ success:false, error:'Servis bulunamadı.' });
  res.json({ success:true, data:guncel });
});

/**
 * POST /api/admin/servis/ekle
 * Manuel olarak yeni bir servis ekle (SMM panelinden bağımsız)
 */
app.post('/api/admin/servis/ekle', adminGuard, async (req, res) => {
  const { vitrinAd, aciklama, emoji, teslimat, kategori, min, max,
          musteriTL, eskiFiyatTL, vitrin, populer, sira, servisId: bodyServisId } = req.body;

  if (!vitrinAd) return res.status(400).json({ success:false, error:'vitrinAd zorunlu.' });

  // Gerçek SMM ID'si verilmişse onu kullan, yoksa negatif ID üret
  let yeniId;
  if (bodyServisId && Number(bodyServisId) > 0) {
    yeniId = Number(bodyServisId);
    const mevcut = await Service.findOne({ servisId: yeniId });
    if (mevcut) return res.status(409).json({ success:false, error:`Servis ID ${yeniId} zaten mevcut.` });
  } else {
    const enKucuk = await Service.findOne({ servisId:{ $lt:0 } }).sort({ servisId:1 });
    yeniId = enKucuk ? enKucuk.servisId - 1 : -1;
  }

  const yeni = await Service.create({
    servisId:    yeniId,
    kategori:    kategori   || 'Manuel',
    orijinalAd:  vitrinAd,
    vitrinAd,
    aciklama:    aciklama   || '',
    emoji:       emoji      || '⭐',
    teslimat:    teslimat   || '',
    min:         Number(min)         || 1,
    max:         Number(max)         || 99999,
    musteriTL:   Number(musteriTL)   || 0,
    eskiFiyatTL: Number(eskiFiyatTL) || 0,
    vitrin:      vitrin  !== undefined ? Boolean(vitrin)  : true,
    aktif:       true,
    populer:     Boolean(populer),
    sira:        Number(sira) || 999,
    fiyat:       0,
  });

  res.json({ success:true, data:yeni });
});

/**
 * GET /api/admin/servis-sorgula/:servisId
 * SosyalBizde'den tek bir servisin bilgisini çeker (ilan ekleme sihirbazı için)
 */
app.get('/api/admin/servis-sorgula/:servisId', adminGuard, async (req, res) => {
  const id = Number(req.params.servisId);
  if (!id) return res.status(400).json({ success:false, error:'Geçersiz servis ID.' });

  try {
    const data = await smmCall({ action:'services' });
    const servis = Array.isArray(data) ? data.find(s => Number(s.service) === id) : null;
    if (!servis) return res.status(404).json({ success:false, error:`ID ${id} bulunamadı.` });
    res.json({ success:true, data:{ id, name:servis.name, min:servis.min, max:servis.max, rate:servis.rate } });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

/**
 * POST /api/admin/toplu-vitrin
 * Birden fazla servisi toplu vitrin aç/kapat.
 * Body: { servisIdler: [101, 103, 105], vitrin: true }
 */
app.post('/api/admin/toplu-vitrin', adminGuard, async (req, res) => {
  const { servisIdler, vitrin } = req.body;
  if (!Array.isArray(servisIdler))
    return res.status(400).json({ success:false, error:'servisIdler dizi olmalı.' });

  const sonuc = await Service.updateMany(
    { servisId: { $in: servisIdler.map(Number) } },
    { $set: { vitrin: Boolean(vitrin), guncellendi:new Date() } }
  );
  res.json({ success:true, guncellenen:sonuc.modifiedCount });
});

/**
 * POST /api/admin/servisleri-guncelle
 * SosyalBizde'den servisleri çekip MongoDB'yi günceller.
 * (npm run servisleri-cek ile de yapılabilir, bu endpoint sunucu içinden tetikler)
 */
app.post('/api/admin/servisleri-guncelle', adminGuard, async (req, res) => {
  try {
    console.log('[SERVİS GÜNCELLE] Başlıyor...');
    const data = await smmCall({ action:'services' });

    if (!Array.isArray(data))
      return res.status(500).json({ success:false, error:'API beklenmeyen yanıt döndü.' });

    let eklenen=0, guncellenen=0;
    for (const s of data) {
      const mevcutDoc = await Service.findOne({ servisId: Number(s.service) });
      const apiData = {
        kategori:   s.category||'',
        orijinalAd: s.name||'',
        fiyat:      parseFloat(s.rate)||0,
        min:        parseInt(s.min)||10,
        max:        parseInt(s.max)||10000,
        guncellendi: new Date(),
      };
      if (mevcutDoc) {
        await Service.updateOne({ servisId:Number(s.service) }, { $set:apiData });
        guncellenen++;
      } else {
        await Service.create({ servisId:Number(s.service), ...apiData,
          vitrin:false, aktif:true, populer:false, sira:999,
          musteriTL:0, eskiFiyatTL:0 });
        eklenen++;
      }
    }
    console.log(`[SERVİS GÜNCELLE] +${eklenen} eklendi, ~${guncellenen} güncellendi`);
    res.json({ success:true, toplam:data.length, eklenen, guncellenen });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

/**
 * GET /api/admin/istatistik
 * Dashboard için özet istatistikler.
 */
app.get('/api/admin/istatistik', adminGuard, async (req, res) => {
  const [toplam, vitrin, aktif, kategoriler, loglar] = await Promise.all([
    Service.countDocuments(),
    Service.countDocuments({ vitrin:true }),
    Service.countDocuments({ aktif:true }),
    Service.distinct('kategori'),
    Promise.resolve(readLog()),
  ]);
  res.json({ success:true, data:{
    toplamServis: toplam,
    vitrinServis: vitrin,
    aktifServis:  aktif,
    kategoriSayisi: kategoriler.length,
    toplamSiparis:  loglar.length,
    basariliSiparis: loglar.filter(l=>l.durum==='iletildi').length,
  }});
});

/**
 * GET /api/admin/loglar
 * Sipariş logları.
 */
app.get('/api/admin/loglar', adminGuard, (req, res) => {
  const loglar = readLog();
  res.json({ success:true, count:loglar.length, data:loglar.slice(0,200) });
});

/* ─────────────────────────────────────────────────────
   SAĞLIK & 404
───────────────────────────────────────────────────── */
app.get('/api/saglik', (req, res) => {
  const dbDurum = mongoose.connection.readyState;
  res.json({ success:true, sunucu:'aktif', db: dbDurum===1?'bağlı':'bağlı değil',
    zaman: new Date().toISOString(), port: PORT });
});

app.use((req, res) => res.status(404).json({ success:false, error:'Endpoint bulunamadı.' }));
app.use((err, req, res, next) => {
  console.error('[SUNUCU HATASI]', err.message);
  res.status(500).json({ success:false, error:'Sunucu hatası.' });
});

/* ─────────────────────────────────────────────────────
   BAŞLAT
───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   TakipçiPro v2 — Sunucu Başladı         ║');
  console.log(`║   Port : ${PORT}                              ║`);
  console.log(`║   DB   : ${MONGO_URI.slice(0,35)}  ║`);
  console.log('║   ngrok: ngrok http ' + PORT + '                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Public  : GET  /api/vitrin');
  console.log('Public  : POST /api/siparis-ver');
  console.log('Admin   : GET  /api/admin/servisler');
  console.log('Admin   : PUT  /api/admin/servis/:id');
  console.log('Admin   : POST /api/admin/servis/ekle');
  console.log('Admin   : POST /api/admin/toplu-vitrin');
  console.log('Admin   : POST /api/admin/servisleri-guncelle');
  console.log('Admin   : GET  /api/admin/istatistik');
  console.log('Sağlık  : GET  /api/saglik\n');
});
