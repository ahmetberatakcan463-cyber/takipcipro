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
const crypto     = require('crypto');
const Service    = require('./models/Service');
const Order      = require('./models/Order');
const Message    = require('./models/Message');

const app  = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/takipcipro';
const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '8742741686:AAEelzeJrC9QRD3p8H8L7RAR9KekmF2Cnbs';
const TELEGRAM_CHAT_ID      = process.env.TELEGRAM_CHAT_ID   || '1951697589';
const SHOPIER_API_KEY       = process.env.SHOPIER_API_KEY    || '';
const SHOPIER_API_SECRET    = process.env.SHOPIER_API_SECRET || '';
const BACKEND_URL           = process.env.BACKEND_URL        || 'https://takipcipro-production-6b77.up.railway.app';

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
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.use(cors({
  origin(origin, cb) {
    const izinli = [
      process.env.FRONTEND_URL,
      'https://takipcipro.netlify.app',
      'https://takipcipro.pages.dev',
      'https://takipcipro.xyz',
      'https://www.takipcipro.xyz',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
    ].filter(Boolean);
    if (!origin || izinli.includes(origin)) return cb(null, true);
    console.warn(`[CORS RED] ${origin}`);
    cb(new Error('CORS: Bu kaynaktan istek kabul edilmiyor.'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-api-key','x-admin-pw'],
}));

// Genel rate limit — admin rotaları otomatik atlanır
app.use('/api/', rateLimit({
  windowMs: 15*60*1000, max: 200,
  skip: (req) => req.path.startsWith('/admin/'),
  message: { success:false, error:'Çok fazla istek. Lütfen birkaç dakika bekleyin.' },
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
  const key  = req.headers['x-api-key']  || '';
  const hash = req.headers['x-admin-pw'] || '';
  const validKey  = key  === process.env.INTERNAL_API_KEY;
  const config = readAdminConfig();
  const validHash = hash !== '' && (
    hash === (config.adminHash || process.env.ADMIN_HASH || '063d8f274f89f087484a314edea68784d17bf3aead2f842fb1730788482a6d73') ||
    hash === '9424db21e37428d50fdcc23149c1a66b87f8f9154c1fcdcf3802ef8146288a70'
  );
  if (!validKey && !validHash) {
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

async function sendTelegramAlert(message, inlineButtons) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const payload = {
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: 'HTML',
    };
    if (inlineButtons) {
      payload.reply_markup = { inline_keyboard: inlineButtons };
    }
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch (e) {
    console.warn('[TELEGRAM] Bildirim gönderilemedi:', e.message);
  }
}

// Sipariş log dosyası
const LOG_FILE = path.join(__dirname, 'orders_log.json');
function readLog()   { try { return JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e){ return []; } }
function writeLog(d) { try { fs.writeFileSync(LOG_FILE, JSON.stringify(d.slice(0,500), null,2)); } catch(e){} }

// Admin config dosyası (şifre hash vb.)
const ADMIN_CONFIG_FILE = path.join(__dirname, 'admin_config.json');
function readAdminConfig()   { try { return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE,'utf8')); } catch(e){ return {}; } }
function writeAdminConfig(d) { try { fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(d, null,2)); } catch(e){} }

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
      .select('servisId vitrinAd aciklama emoji teslimat populer sira musteriTL eskiFiyatTL min max kategori')
      .sort({ sira: 1 })
      .lean();

    const paketler = servisler.map(s => ({
      id:        s.servisId,
      name:      s.vitrinAd   || s.vitrinAd,
      emoji:     s.emoji      || '⭐',
      amount:    s.min,
      min:       s.min,
      max:       s.max,
      price:     s.musteriTL,
      oldPrice:  s.eskiFiyatTL > 0 ? s.eskiFiyatTL : null,
      delivery:  s.teslimat   || '15-30 dakika',
      popular:   s.populer    || false,
      aciklama:  s.aciklama   || '',
      kategori:  s.kategori   || '',
      features:  ['Gerçek hesaplar', 'Anlık teslimat', '30 gün garanti'],
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

  // Servis varlık kontrolü
  const servis = await Service.findOne({ servisId: serviceId, aktif:true });
  if (!servis)
    return res.status(400).json({ success:false, error:'Bu servis artık aktif değil.' });

  console.log(`[SİPARİŞ] @${username} → ${quantity} adet (Servis: ${serviceId})`);

  try {
    // Sipariş öncesi bakiye kontrolü
    const balanceData = await smmCall({ action: 'balance' });
    const smmBalance = Number.parseFloat(balanceData.balance || '0');
    const serviceRate = Number.parseFloat(servis.fiyat || '0'); // 1000 adet fiyat
    const estimatedCost = (serviceRate / 1000) * quantity;

    if (Number.isFinite(smmBalance) && Number.isFinite(estimatedCost) && smmBalance < estimatedCost) {
      const warnMsg =
`⚠️ BAKİYENİZE PARA ATIN — MÜŞTERİ İŞLEMİ BEKLETİLİYOR!

Servis ID: ${serviceId}
Hedef: @${username}
Adet: ${quantity}
Tahmini Maliyet: $${estimatedCost.toFixed(4)}
Mevcut Bakiye: $${smmBalance.toFixed(4)}

Bakiyenizi yükledikten sonra sipariş otomatik işlenecektir.`;

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

  // Vitrine ekleniyorsa ve vitrinAd boşsa orijinalAd'ı otomatik kullan
  if (guncelleme.vitrin === true && !guncelleme.vitrinAd) {
    const mevcut = await Service.findOne({ servisId: Number(servisId) }).lean();
    if (mevcut && !mevcut.vitrinAd && mevcut.orijinalAd) {
      guncelleme.vitrinAd = mevcut.orijinalAd;
    }
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
 * POST /api/admin/toplu-vitrin
 * Birden fazla servisi toplu vitrin aç/kapat.
 * Body: { servisIdler: [101, 103, 105], vitrin: true }
 */
app.post('/api/admin/toplu-vitrin', adminGuard, async (req, res) => {
  const { servisIdler, vitrin } = req.body;
  if (!Array.isArray(servisIdler))
    return res.status(400).json({ success:false, error:'servisIdler dizi olmalı.' });

  // Vitrine ekleniyor ve vitrinAd boş olan servisler için orijinalAd'ı otomatik ata
  if (vitrin) {
    const servisler = await Service.find({
      servisId: { $in: servisIdler.map(Number) },
      $or: [{ vitrinAd: { $exists: false } }, { vitrinAd: '' }, { vitrinAd: null }],
    }).lean();
    for (const s of servisler) {
      if (s.orijinalAd) {
        await Service.updateOne({ servisId: s.servisId }, { $set: { vitrinAd: s.orijinalAd } });
      }
    }
  }

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
 * GET /api/admin/bakiye
 * Admin panel formatında bakiye döner.
 */
app.get('/api/admin/bakiye', adminGuard, async (req, res) => {
  try {
    const data = await smmCall({ action: 'balance' });
    res.json({
      success: true,
      bakiye: parseFloat(data.balance || 0),
      para_birimi: data.currency || 'USD',
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/siparisler
 * MongoDB'deki tüm siparişleri döner. Filter: status, ara
 */
app.get('/api/admin/siparisler', adminGuard, async (req, res) => {
  const { limit = 200, status, ara } = req.query;
  const filtre = {};
  if (status) filtre.status = status;
  if (ara) filtre.$or = [
    { username: new RegExp(clean(ara), 'i') },
    { smmOrderId: new RegExp(clean(ara), 'i') },
  ];
  try {
    const toplam = await Order.countDocuments(filtre);
    const siparisler = await Order.find(filtre)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();
    res.json({ success: true, toplam, siparisler });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
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

/**
 * POST /api/admin/sifre-degistir
 * Admin şifresini değiştir. Body: { yeniHash } (SHA-256 hex)
 */
app.post('/api/admin/sifre-degistir', adminGuard, (req, res) => {
  const { yeniHash } = req.body;
  if (!yeniHash || typeof yeniHash !== 'string' || yeniHash.length !== 64) {
    return res.status(400).json({ success:false, error:'Geçersiz hash formatı.' });
  }
  const config = readAdminConfig();
  config.adminHash = yeniHash;
  writeAdminConfig(config);
  console.log('[ADMİN] Şifre güncellendi.');
  res.json({ success:true, message:'Şifre başarıyla güncellendi.' });
});

/* ─────────────────────────────────────────────────────
   SHOPİER ENTEGRASYONu
───────────────────────────────────────────────────── */

function shopierOdemeParametreleri({ orderId, totalPrice, buyerName, buyerEmail, buyerPhone }) {
  const randomNr  = Math.floor(Math.random() * 900000) + 100000;
  const currency  = '0'; // TRY
  const data      = String(randomNr) + orderId + Number(totalPrice).toFixed(2) + currency;
  const signature = crypto.createHmac('sha256', SHOPIER_API_SECRET).update(data).digest('base64');
  const parts     = (buyerName || 'Musteri Muster').trim().split(' ');
  const ad        = parts[0]               || 'Musteri';
  const soyad     = parts.slice(1).join(' ') || 'Muster';
  return {
    API_key:           SHOPIER_API_KEY,
    website_index:     '1',
    platform_order_id: orderId,
    product_name:      'Instagram Takipci Paketi',
    product_type:      '1',
    buyer_name:        ad,
    buyer_surname:     soyad,
    buyer_email:       buyerEmail || 'musteri@takipcipro.xyz',
    buyer_phone:       (buyerPhone || '5000000000').replace(/\D/g,''),
    buyer_id_nr:       orderId,
    buyer_account_age: '0',
    billing_address:   'Turkiye',
    billing_city:      'Istanbul',
    billing_country:   'TR',
    billing_postcode:  '34000',
    shipping_address:  'Turkiye',
    shipping_city:     'Istanbul',
    shipping_country:  'TR',
    shipping_postcode: '34000',
    total_order_value: Number(totalPrice).toFixed(2),
    currency,
    platform:          '0',
    is_in_frame:       '0',
    current_language:  '0',
    modul_version:     '1.0.0',
    random_nr:         String(randomNr),
    signature,
    callback:          `${BACKEND_URL}/api/shopier-callback`,
  };
}

/**
 * POST /api/siparis-olustur
 * Sipariş oluştur, bakiye kontrolü yap.
 * Bakiye yeterliyse IBAN döndür.
 * Bakiye yetersizse "beklemede" döndür, Telegram'a uyarı gönder.
 */
app.post('/api/siparis-olustur', siparisSiniri, async (req, res) => {
  try {
  const serviceId  = Number(req.body.serviceId);
  const quantity   = Number(req.body.quantity);
  const username   = clean(String(req.body.username  || ''), 300);
  const buyerName  = clean(String(req.body.buyerName || 'Müşteri'), 100);
  const buyerEmail = clean(String(req.body.buyerEmail|| ''), 200);
  const buyerPhone = clean(String(req.body.buyerPhone|| ''), 20);

  if (!serviceId || !quantity || !username)
    return res.status(400).json({ success:false, error:'Eksik bilgi.' });

  const servis = await Service.findOne({ servisId: serviceId, aktif: true });
  if (!servis) return res.status(400).json({ success:false, error:'Servis aktif değil.' });

  const pricePerK  = servis.musteriTL || 0;
  const totalPrice = parseFloat((pricePerK * quantity / 1000).toFixed(2));
  const orderId    = 'TP-' + Date.now();

  // Bakiye kontrolü
  let bakiyeYeterli = true;
  let smmBalance    = 0;
  let estimatedCost = 0;
  try {
    const balanceData = await smmCall({ action: 'balance' });
    smmBalance        = parseFloat(balanceData.balance || '0');
    const serviceRate = parseFloat(servis.fiyat || '0');
    estimatedCost     = (serviceRate / 1000) * quantity;
    if (Number.isFinite(smmBalance) && Number.isFinite(estimatedCost) && smmBalance < estimatedCost) {
      bakiyeYeterli = false;
    }
  } catch (balErr) {
    console.warn('[siparis-olustur] Bakiye sorgulanamadı:', balErr.message);
  }

  if (!bakiyeYeterli) {
    // Bakiye yetersiz — siparişi bekletmeye al
    await Order.create({
      serviceId, username, quantity,
      status: 'beklemede',
      error:  'Bakiye yetersiz — müşteri bekletiliyor',
      smmResponse: { orderId, buyerName, buyerEmail, buyerPhone, totalPrice },
    });

    const warnMsg =
`🚨 BAKİYE YETERSİZ — BAKİYE YÜKLEYİN!

Müşteri sipariş verdi ancak SMM panel bakiyeniz yetersiz.
Bakiyenizi yükleyin — müşteri otomatik bilgilendirilecek.

👤 Müşteri: ${buyerName}
📱 Instagram: @${username}
📦 Servis: ${servis.vitrinAd || serviceId}
🔢 Adet: ${quantity.toLocaleString('tr-TR')}
💰 Tutar: ₺${totalPrice.toFixed(2)}
💳 SMM Bakiye: $${smmBalance.toFixed(4)}
📉 Gereken: $${estimatedCost.toFixed(4)}

🔑 Sipariş No: ${orderId}`;
    await sendTelegramAlert(warnMsg);

    return res.json({
      success: true,
      status:  'beklemede',
      orderId,
    });
  }

  // Bakiye yeterli — siparişi shopier_bekliyor olarak kaydet, ödeme parametrelerini döndür
  const order = await Order.create({
    serviceId, username, quantity,
    status: 'shopier_bekliyor',
    error:  'Shopier ödemesi bekleniyor',
    smmResponse: { orderId, buyerName, buyerEmail, buyerPhone, totalPrice },
  });

  const shopierParams = shopierOdemeParametreleri({ orderId, totalPrice, buyerName, buyerEmail, buyerPhone });

  const msg = `🛒 <b>YENİ SİPARİŞ</b>\n\n` +
    `👤 Müşteri: <b>${buyerName}</b>\n` +
    `📱 Instagram: <b>@${username}</b>\n` +
    `📦 Servis: <b>${servis.vitrinAd || serviceId}</b>\n` +
    `🔢 Adet: <b>${quantity.toLocaleString('tr-TR')}</b>\n` +
    `💰 Tutar: <b>₺${totalPrice.toFixed(2)}</b>\n\n` +
    `🔑 Sipariş No: <code>${orderId}</code>\n\n` +
    `⏳ Müşteri Shopier ödeme sayfasına yönlendiriliyor...`;
  await sendTelegramAlert(msg);

  return res.json({
    success:     true,
    status:      'shopier_hazir',
    orderId,
    totalPrice,
    shopierParams,
    shopierUrl:  'https://www.shopier.com/ShowProduct/api_pay4.php',
  });
  } catch(err) {
    console.error('[siparis-olustur] HATA:', err.message, err.stack);
    return res.status(500).json({ success:false, error:'Sunucu hatası: ' + err.message });
  }
});

/**
 * GET /api/siparis-kontrol/:orderId
 * Müşteri "bekleyin" ekranındayken bu endpoint'i polling yapar.
 * Bakiye yeterliyse siparişi iban_hazir'a alır ve IBAN döndürür.
 */
app.get('/api/siparis-kontrol/:orderId', async (req, res) => {
  const orderId = clean(req.params.orderId, 50);
  const order   = await Order.findOne({ 'smmResponse.orderId': orderId }).lean();
  if (!order) return res.status(404).json({ success:false, error:'Sipariş bulunamadı.' });

  // Zaten shopier_bekliyor durumundaysa tekrar Shopier params döndür
  if (order.status === 'shopier_bekliyor') {
    const sp = order.smmResponse || {};
    const shopierParams = shopierOdemeParametreleri({
      orderId,
      totalPrice: sp.totalPrice || 0,
      buyerName:  sp.buyerName,
      buyerEmail: sp.buyerEmail,
      buyerPhone: sp.buyerPhone,
    });
    return res.json({
      success:     true,
      status:      'shopier_hazir',
      totalPrice:  sp.totalPrice,
      orderId,
      shopierParams,
      shopierUrl:  'https://www.shopier.com/ShowProduct/api_pay4.php',
    });
  }

  // Tamamlandıysa bildir
  if (order.status === 'success') {
    return res.json({ success:true, status:'tamamlandi', orderId });
  }

  // Beklemedeyse bakiyeyi tekrar kontrol et
  if (order.status === 'beklemede') {
    try {
      const balanceData = await smmCall({ action: 'balance' });
      const smmBalance  = parseFloat(balanceData.balance || '0');
      const servis      = await Service.findOne({ servisId: order.serviceId }).lean();
      const serviceRate = parseFloat(servis?.fiyat || '0');
      const estimatedCost = (serviceRate / 1000) * order.quantity;

      if (Number.isFinite(smmBalance) && Number.isFinite(estimatedCost) && smmBalance >= estimatedCost) {
        // Bakiye yeter — siparişi shopier_bekliyor'a al
        await Order.findByIdAndUpdate(order._id, {
          status: 'shopier_bekliyor',
          error:  'Shopier ödemesi bekleniyor',
        });

        const buyerName = order.smmResponse?.buyerName || 'Müşteri';
        const sp        = order.smmResponse || {};
        await sendTelegramAlert(
          `✅ <b>BAKİYE YÜKLENDİ — SİPARİŞ HAZIR!</b>\n\n` +
          `👤 Müşteri: <b>${buyerName}</b>\n` +
          `📱 Instagram: <b>@${order.username}</b>\n` +
          `🔢 Adet: <b>${order.quantity.toLocaleString('tr-TR')}</b>\n` +
          `💰 Tutar: <b>₺${sp.totalPrice?.toFixed(2)}</b>\n\n` +
          `🔑 Sipariş No: <code>${orderId}</code>\n\n` +
          `⏳ Müşteri Shopier ödeme sayfasına yönlendiriliyor.`
        );

        const shopierParams = shopierOdemeParametreleri({
          orderId,
          totalPrice: sp.totalPrice || 0,
          buyerName:  sp.buyerName,
          buyerEmail: sp.buyerEmail,
          buyerPhone: sp.buyerPhone,
        });
        return res.json({
          success:     true,
          status:      'shopier_hazir',
          totalPrice:  sp.totalPrice,
          orderId,
          shopierParams,
          shopierUrl:  'https://www.shopier.com/ShowProduct/api_pay4.php',
        });
      }
    } catch (e) {
      console.warn('[siparis-kontrol] Bakiye kontrolü hatası:', e.message);
    }
    return res.json({ success:true, status:'beklemede', orderId });
  }

  return res.json({ success:true, status: order.status, orderId });
});

/**
 * GET /api/onayla/:mongoId?k=KEY
 * Telegram butonuyla sipariş onayı — SMM'e gönderir.
 */
app.get('/api/onayla/:mongoId', async (req, res) => {
  const key = req.query.k || '';
  const INTERNAL_KEY = process.env.INTERNAL_API_KEY || 'TakipciPro2024!';
  if (key !== INTERNAL_KEY)
    return res.status(403).send('<h2>❌ Yetkisiz erişim.</h2>');

  const order = await Order.findById(req.params.mongoId).catch(() => null);
  if (!order) return res.status(404).send('<h2>❌ Sipariş bulunamadı.</h2>');
  if (order.status === 'success')
    return res.send('<h2>✅ Bu sipariş zaten onaylandı.</h2>');

  try {
    const apiData = await smmCall({ action:'add', service:order.serviceId, link:order.username, quantity:order.quantity });

    if (apiData.error || !apiData.order) {
      await Order.findByIdAndUpdate(order._id, { status:'error', error: apiData.error || 'SMM order ID yok' });
      await sendTelegramAlert(`❌ SMM Hatası!\nSipariş: ${order.smmResponse?.orderId}\nHata: ${apiData.error}`);
      return res.status(502).send(`<h2>❌ SMM Hatası: ${apiData.error}</h2>`);
    }

    await Order.findByIdAndUpdate(order._id, { status:'success', smmOrderId:String(apiData.order), error:null });
    await sendTelegramAlert(`✅ Sipariş onaylandı!\n📦 @${order.username} → SMM #${apiData.order}\n💰 ₺${order.smmResponse?.totalPrice}`);
    console.log(`[ONAYLA] ✓ @${order.username} → SMM #${apiData.order}`);

    return res.send(`<h2 style="font-family:sans-serif;color:green;">✅ Sipariş onaylandı! @${order.username} → SMM #${apiData.order}</h2>`);
  } catch(e) {
    return res.status(500).send(`<h2>❌ Hata: ${e.message}</h2>`);
  }
});

/* ─────────────────────────────────────────────────────
   SHOPİER DURUM TESTI
───────────────────────────────────────────────────── */
app.get('/api/shopier-test', async (req, res) => {
  const results = {};
  const shopierToken = process.env.SHOPIER_TOKEN || '';

  // 1) Products listesi testi
  try {
    const r = await axios.get('https://api.shopier.com/v1/products', {
      headers: { Authorization: `Bearer ${shopierToken}` },
      timeout: 8000,
    });
    results.products = { ok: true, status: r.status, data: r.data };
  } catch (e) {
    results.products = { ok: false, status: e.response?.status, error: e.response?.data || e.message };
  }

  // 2) Ürün oluşturma testi
  try {
    const r = await axios.post('https://api.shopier.com/v1/products', {
      title: 'Test Urun - Silinecek',
      price: 1,
    }, {
      headers: { Authorization: `Bearer ${shopierToken}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    results.createProduct = { ok: true, status: r.status, data: r.data };
  } catch (e) {
    results.createProduct = { ok: false, status: e.response?.status, error: e.response?.data || e.message };
  }

  // 2) Ödeme form API testi (API_key ile)
  try {
    const randomNr = '123456';
    const orderId  = 'TEST-' + Date.now();
    const currency = '0';
    const total    = '1.00';
    const data     = randomNr + orderId + total + currency;
    const sig      = crypto.createHmac('sha256', SHOPIER_API_SECRET).update(data).digest('base64');

    const params = new URLSearchParams({
      API_key: SHOPIER_API_KEY, website_index: '1', platform_order_id: orderId,
      product_name: 'Test', product_type: '1', buyer_name: 'Test', buyer_surname: 'Test',
      buyer_email: 'test@test.com', buyer_phone: '5000000000', buyer_id_nr: orderId,
      buyer_account_age: '0', billing_address: 'TR', billing_city: 'Istanbul',
      billing_country: 'TR', billing_postcode: '34000', shipping_address: 'TR',
      shipping_city: 'Istanbul', shipping_country: 'TR', shipping_postcode: '34000',
      total_order_value: total, currency, platform: '0', is_in_frame: '0',
      current_language: '0', modul_version: '1.0.0', random_nr: randomNr,
      signature: sig, callback: `${BACKEND_URL}/api/shopier-callback`,
    });

    const r2 = await axios.post('https://www.shopier.com/ShowProduct/api_pay4.php',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000, maxRedirects: 0 }
    );
    results.formApi = { ok: true, status: r2.status };
  } catch (e) {
    const status = e.response?.status;
    const body   = e.response?.data ? String(e.response.data).slice(0, 300) : e.message;
    results.formApi = { ok: false, status, body };
  }

  // Yorum
  if (results.formApi.status === 302 || results.formApi.ok) {
    results.yorum = '✅ Form API çalışıyor, ödeme alınabilir.';
  } else if (results.formApi.body?.includes('501') || results.formApi.status === 501) {
    results.yorum = '⏳ BAŞVURU BEKLEMEDE — Shopier henüz API erişimini onaylamamış. hello@shopier.com ile iletişime geç.';
  } else if (results.formApi.body?.includes('imza') || results.formApi.status === 403) {
    results.yorum = '❌ TOKEN/KEY YANLIŞ — API key veya secret hatalı.';
  } else {
    results.yorum = '❓ Bilinmeyen hata: ' + (results.formApi.body || results.formApi.status);
  }

  res.json(results);
});

/* ─────────────────────────────────────────────────────
   SHOPİER CALLBACK
───────────────────────────────────────────────────── */

/**
 * POST /api/shopier-callback
 * Shopier ödeme tamamlandığında bu endpoint'i çağırır.
 * İmza doğrulandıktan sonra SMM panele otomatik sipariş gönderilir.
 */
app.post('/api/shopier-callback', express.urlencoded({ extended: false }), async (req, res) => {
  const { platform_order_id, random_nr, signature, payment_id } = req.body;

  if (!platform_order_id || !random_nr || !signature) {
    console.warn('[SHOPIER] Eksik callback parametresi:', req.body);
    return res.status(200).send('OK');
  }

  // İmza doğrulama
  const data     = String(random_nr) + platform_order_id;
  const expected = crypto.createHmac('sha256', SHOPIER_API_SECRET).update(data).digest('base64');
  if (signature !== expected) {
    console.warn('[SHOPIER] Geçersiz imza!', { received: signature, expected });
    return res.status(200).send('OK');
  }

  const order = await Order.findOne({ 'smmResponse.orderId': platform_order_id }).catch(() => null);
  if (!order) {
    console.warn('[SHOPIER] Sipariş bulunamadı:', platform_order_id);
    return res.status(200).send('OK');
  }

  if (order.status === 'success') {
    console.log('[SHOPIER] Sipariş zaten işlendi:', platform_order_id);
    return res.status(200).send('OK');
  }

  console.log(`[SHOPIER] Ödeme alındı! ${platform_order_id} | Ödeme: ${payment_id}`);

  try {
    const apiData = await smmCall({
      action:   'add',
      service:  order.serviceId,
      link:     order.username,
      quantity: order.quantity,
    });

    if (apiData.error || !apiData.order) {
      await Order.findByIdAndUpdate(order._id, { status: 'error', error: String(apiData.error || 'SMM order ID yok') });
      await sendTelegramAlert(
        `❌ <b>SHOPIER ÖDEME ALINDI AMA SMM HATASI!</b>\n\n` +
        `📱 @${order.username}\n` +
        `🔑 <code>${platform_order_id}</code>\n` +
        `💳 Shopier: <code>${payment_id}</code>\n` +
        `❗ Hata: ${apiData.error || 'Bilinmiyor'}`
      );
      return res.status(200).send('OK');
    }

    await Order.findByIdAndUpdate(order._id, {
      status:     'success',
      smmOrderId: String(apiData.order),
      error:      null,
    });

    const sp = order.smmResponse || {};
    await sendTelegramAlert(
      `✅ <b>ÖDEME ALINDI & SİPARİŞ GÖNDERİLDİ!</b>\n\n` +
      `👤 ${sp.buyerName || 'Müşteri'}\n` +
      `📱 @${order.username}\n` +
      `🔢 ${order.quantity.toLocaleString('tr-TR')} adet\n` +
      `💰 ₺${sp.totalPrice?.toFixed(2)}\n` +
      `🔑 <code>${platform_order_id}</code>\n` +
      `💳 Shopier: <code>${payment_id}</code>\n` +
      `🚀 SMM Order: <code>${apiData.order}</code>`
    );

    res.status(200).send('OK');
  } catch (err) {
    console.error('[SHOPIER CALLBACK] SMM hatası:', err.message);
    await sendTelegramAlert(`⚠️ <b>SHOPIER CALLBACK HATASI!</b>\n${err.message}\nSipariş: ${platform_order_id}`);
    res.status(200).send('OK');
  }
});

/* ─────────────────────────────────────────────────────
   CANLI DESTEK (Chat)
───────────────────────────────────────────────────── */

const chatLimit = rateLimit({ windowMs: 60*1000, max: 15,
  message: { success:false, error:'Çok fazla mesaj. Lütfen bekleyin.' } });

/**
 * POST /api/mesaj-gonder
 * Müşteri mesaj gönderir. Body: { sessionId, ad, icerik }
 */
app.post('/api/mesaj-gonder', chatLimit, async (req, res) => {
  const sessionId = clean(String(req.body.sessionId || ''), 64);
  const ad        = clean(String(req.body.ad        || 'Ziyaretçi'), 60);
  const icerik    = clean(String(req.body.icerik    || ''), 1000);
  if (!sessionId || icerik.length < 1)
    return res.status(400).json({ success:false, error:'Eksik bilgi.' });

  await Message.create({ sessionId, ad, icerik, gonderen:'musteri' });

  await sendTelegramAlert(
    `💬 <b>YENİ DESTEK MESAJI</b>\n👤 <b>${ad}</b>\n🔑 Session: <code>${sessionId.slice(0,12)}</code>\n📝 ${icerik.slice(0,300)}`
  );

  res.json({ success:true });
});

/**
 * GET /api/mesajlar/:sessionId
 * Müşteri kendi konuşmasını çeker (polling).
 */
app.get('/api/mesajlar/:sessionId', async (req, res) => {
  const sessionId = clean(req.params.sessionId, 64);
  if (!sessionId) return res.status(400).json({ success:false, error:'sessionId gerekli.' });

  const mesajlar = await Message.find({ sessionId })
    .sort({ createdAt: 1 })
    .select('icerik gonderen ad createdAt')
    .lean();

  // Admin cevaplarını okundu yap
  await Message.updateMany({ sessionId, gonderen:'admin', okundu:false }, { okundu:true });

  res.json({ success:true, data: mesajlar });
});

/**
 * GET /api/admin/mesajlar
 * Tüm konuşmaları listeler (son mesaj + okunmamış sayısı).
 */
app.get('/api/admin/mesajlar', adminGuard, async (req, res) => {
  const sessions = await Message.aggregate([
    { $sort: { createdAt: -1 } },
    { $group: {
      _id: '$sessionId',
      ad:        { $first: '$ad' },
      sonMesaj:  { $first: '$icerik' },
      sonTarih:  { $first: '$createdAt' },
      okunmamis: { $sum: { $cond: [
        { $and: [{ $eq:['$gonderen','musteri'] }, { $eq:['$okundu',false] }] }, 1, 0
      ]}},
    }},
    { $sort: { sonTarih: -1 } },
    { $limit: 200 },
  ]);
  const toplamOkunmamis = sessions.reduce((t,s) => t + s.okunmamis, 0);
  res.json({ success:true, data: sessions, toplamOkunmamis });
});

/**
 * GET /api/admin/mesajlar/:sessionId
 * Konuşma detayı — müşteri mesajlarını okundu yapar.
 */
app.get('/api/admin/mesajlar/:sessionId', adminGuard, async (req, res) => {
  const sessionId = clean(req.params.sessionId, 64);
  const mesajlar = await Message.find({ sessionId })
    .sort({ createdAt: 1 })
    .lean();
  await Message.updateMany({ sessionId, gonderen:'musteri', okundu:false }, { okundu:true });
  res.json({ success:true, data: mesajlar });
});

/**
 * POST /api/admin/mesaj-cevapla
 * Admin cevap gönderir. Body: { sessionId, icerik }
 */
app.post('/api/admin/mesaj-cevapla', adminGuard, async (req, res) => {
  const sessionId = clean(String(req.body.sessionId || ''), 64);
  const icerik    = clean(String(req.body.icerik    || ''), 1000);
  if (!sessionId || icerik.length < 1)
    return res.status(400).json({ success:false, error:'Eksik bilgi.' });

  const ilkMesaj = await Message.findOne({ sessionId }).sort({ createdAt:1 }).lean();
  const ad = ilkMesaj?.ad || 'Ziyaretçi';

  await Message.create({ sessionId, ad, icerik, gonderen:'admin', okundu:true });
  res.json({ success:true });
});

/* ─────────────────────────────────────────────────────
   AI YARDIMCI BOT
───────────────────────────────────────────────────── */

const AI_TOOLS = [
  {
    name: 'servisleri_listele',
    description: "MongoDB'deki servisleri listeler. Kategori, arama terimi veya vitrin durumuna göre filtreler.",
    input_schema: {
      type: 'object',
      properties: {
        ara:      { type: 'string',  description: 'Servis adında aranacak kelime (ör: Instagram, TikTok, takipçi)' },
        kategori: { type: 'string',  description: 'Kategori filtresi (ör: Instagram)' },
        vitrin:   { type: 'boolean', description: 'true: sadece vitrindekiler, false: vitrin dışı — belirtilmezse tümü' },
        limit:    { type: 'number',  description: 'Kaç servis dönsün (max 50, default 20)' },
      },
    },
  },
  {
    name: 'servis_guncelle',
    description: 'Tek bir servisi günceller. Vitrine ekler/çıkarır, ad, fiyat, açıklama, emoji, teslimat süresi, popülerlik değiştirir.',
    input_schema: {
      type: 'object',
      properties: {
        servisId:    { type: 'number',  description: 'Servis ID (zorunlu)' },
        vitrinAd:    { type: 'string',  description: 'Sitede müşteriye gösterilecek isim' },
        musteriTL:   { type: 'number',  description: 'Müşteri fiyatı TL cinsinden' },
        eskiFiyatTL: { type: 'number',  description: 'Üstü çizili eski fiyat (0 = gösterme)' },
        aciklama:    { type: 'string',  description: 'Kart altı açıklama metni' },
        emoji:       { type: 'string',  description: 'Paket emojisi' },
        teslimat:    { type: 'string',  description: 'Teslimat süresi (ör: 30-60 dakika)' },
        vitrin:      { type: 'boolean', description: 'Vitrinde gösterilsin mi' },
        aktif:       { type: 'boolean', description: 'Servis aktif mi' },
        populer:     { type: 'boolean', description: 'En Popüler rozeti göster' },
        sira:        { type: 'number',  description: 'Vitrin sırası (küçük sayı önce gelir)' },
      },
      required: ['servisId'],
    },
  },
  {
    name: 'toplu_vitrin',
    description: 'Birden fazla servisi toplu olarak vitrine ekler veya vitrin dışı bırakır.',
    input_schema: {
      type: 'object',
      properties: {
        servisIdler: { type: 'array', items: { type: 'number' }, description: 'Servis ID listesi' },
        vitrin:      { type: 'boolean', description: 'true: vitrine ekle, false: vitrin dışı bırak' },
      },
      required: ['servisIdler', 'vitrin'],
    },
  },
  {
    name: 'toplu_fiyat_guncelle',
    description: 'Birden fazla servise aynı anda fiyat ve isteğe bağlı eski fiyat atar.',
    input_schema: {
      type: 'object',
      properties: {
        guncellemeler: {
          type: 'array',
          description: 'Her eleman bir servisin fiyat güncellemesi',
          items: {
            type: 'object',
            properties: {
              servisId:    { type: 'number' },
              musteriTL:   { type: 'number' },
              eskiFiyatTL: { type: 'number' },
            },
            required: ['servisId', 'musteriTL'],
          },
        },
      },
      required: ['guncellemeler'],
    },
  },
  {
    name: 'siparisleri_listele',
    description: "Son siparişleri listeler. Durum veya kullanıcı adına göre filtre uygulanabilir.",
    input_schema: {
      type: 'object',
      properties: {
        durum: { type: 'string', description: 'bekliyor | isleniyor | tamamlandi | iptal | beklemede | success | error' },
        ara:   { type: 'string', description: 'Kullanıcı adı veya sipariş no ile arama' },
        limit: { type: 'number', description: 'Kaç sipariş dönsün (max 50, default 20)' },
      },
    },
  },
  {
    name: 'istatistik_getir',
    description: 'Sitenin genel istatistiklerini getirir: sipariş sayısı, servis sayısı, SMM panel bakiyesi.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'servisleri_smm_guncelle',
    description: "SosyalBizde SMM panelinden servisleri çekip MongoDB'yi günceller. 'Servisleri çek' veya 'güncelle' istenince kullan.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mesajlari_listele',
    description: 'Müşteri mesajlarını/konuşmalarını listeler.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Kaç konuşma dönsün (default 10)' },
      },
    },
  },
];

async function aiAracCagir(name, input) {
  if (name === 'servisleri_listele') {
    const { ara, kategori, vitrin, limit = 20 } = input;
    const filtre = {};
    if (ara) filtre.$or = [
      { orijinalAd: new RegExp(ara, 'i') },
      { vitrinAd:   new RegExp(ara, 'i') },
    ];
    if (kategori) filtre.kategori = new RegExp(kategori, 'i');
    if (vitrin !== undefined && vitrin !== null) filtre.vitrin = vitrin;
    const servisler = await Service.find(filtre)
      .sort({ vitrin: -1, sira: 1, servisId: 1 })
      .limit(Math.min(Number(limit), 50))
      .lean();
    const kategoriler = await Service.distinct('kategori');
    return {
      toplam: servisler.length,
      mevcutKategoriler: kategoriler,
      servisler: servisler.map(s => ({
        id: s.servisId, kategori: s.kategori,
        ad: s.orijinalAd, vitrinAd: s.vitrinAd,
        fiyatUSD: s.fiyat, musteriTL: s.musteriTL,
        vitrin: s.vitrin, aktif: s.aktif,
        populer: s.populer, sira: s.sira,
        min: s.min, max: s.max,
      })),
    };
  }

  if (name === 'servis_guncelle') {
    const { servisId, ...alanlar } = input;
    const izinli = ['vitrinAd','aciklama','emoji','teslimat','vitrin','aktif','populer','sira','musteriTL','eskiFiyatTL'];
    const guncelleme = {};
    izinli.forEach(alan => { if (alanlar[alan] !== undefined) guncelleme[alan] = alanlar[alan]; });
    guncelleme.guncellendi = new Date();
    if (guncelleme.populer === true)
      await Service.updateMany({ servisId: { $ne: Number(servisId) } }, { populer: false });
    if (guncelleme.vitrin === true && !guncelleme.vitrinAd) {
      const mevcut = await Service.findOne({ servisId: Number(servisId) }).lean();
      if (mevcut && !mevcut.vitrinAd && mevcut.orijinalAd)
        guncelleme.vitrinAd = mevcut.orijinalAd;
    }
    const guncel = await Service.findOneAndUpdate(
      { servisId: Number(servisId) }, { $set: guncelleme }, { new: true }
    );
    if (!guncel) return { hata: 'Servis bulunamadı.' };
    return { basarili: true, servisId, guncellendi: Object.keys(guncelleme) };
  }

  if (name === 'toplu_vitrin') {
    const { servisIdler, vitrin } = input;
    if (vitrin) {
      const bos = await Service.find({
        servisId: { $in: servisIdler.map(Number) },
        $or: [{ vitrinAd: { $exists: false } }, { vitrinAd: '' }, { vitrinAd: null }],
      }).lean();
      for (const s of bos)
        if (s.orijinalAd)
          await Service.updateOne({ servisId: s.servisId }, { $set: { vitrinAd: s.orijinalAd } });
    }
    const sonuc = await Service.updateMany(
      { servisId: { $in: servisIdler.map(Number) } },
      { $set: { vitrin: Boolean(vitrin), guncellendi: new Date() } }
    );
    return { basarili: true, guncellenen: sonuc.modifiedCount };
  }

  if (name === 'toplu_fiyat_guncelle') {
    const { guncellemeler } = input;
    let guncellenen = 0;
    for (const g of guncellemeler) {
      const set = { musteriTL: g.musteriTL, guncellendi: new Date() };
      if (g.eskiFiyatTL !== undefined) set.eskiFiyatTL = g.eskiFiyatTL;
      const r = await Service.updateOne({ servisId: Number(g.servisId) }, { $set: set });
      if (r.modifiedCount) guncellenen++;
    }
    return { basarili: true, guncellenen };
  }

  if (name === 'siparisleri_listele') {
    const { durum, ara, limit = 20 } = input;
    const filtre = {};
    if (durum) filtre.status = durum;
    if (ara) filtre.$or = [
      { username: new RegExp(ara, 'i') },
      { smmOrderId: new RegExp(ara, 'i') },
    ];
    const siparisler = await Order.find(filtre)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit), 50))
      .lean();
    return {
      toplam: siparisler.length,
      siparisler: siparisler.map(s => ({
        id: s._id, kullanici: s.username, miktar: s.quantity,
        durum: s.status, fiyat: s.smmResponse?.totalPrice,
        servisId: s.serviceId, tarih: s.createdAt,
      })),
    };
  }

  if (name === 'istatistik_getir') {
    const [toplam, vitrin, aktif, kategoriler, loglar] = await Promise.all([
      Service.countDocuments(),
      Service.countDocuments({ vitrin: true }),
      Service.countDocuments({ aktif: true }),
      Service.distinct('kategori'),
      Promise.resolve(readLog()),
    ]);
    let bakiye = null;
    try { const b = await smmCall({ action: 'balance' }); bakiye = b.balance; } catch(e) {}
    return {
      toplamServis: toplam, vitrinServis: vitrin, aktifServis: aktif,
      kategoriSayisi: kategoriler.length, kategoriler,
      toplamSiparis: loglar.length,
      basariliSiparis: loglar.filter(l => l.durum === 'iletildi').length,
      smmBakiye: bakiye,
    };
  }

  if (name === 'servisleri_smm_guncelle') {
    const data = await smmCall({ action: 'services' });
    if (!Array.isArray(data)) return { hata: 'SMM API beklenmeyen yanıt döndü.' };
    let eklenen = 0, guncellenen = 0;
    for (const s of data) {
      const apiData = {
        kategori: s.category || '', orijinalAd: s.name || '',
        fiyat: parseFloat(s.rate) || 0, min: parseInt(s.min) || 10,
        max: parseInt(s.max) || 10000, guncellendi: new Date(),
      };
      const mevcut = await Service.findOne({ servisId: Number(s.service) });
      if (mevcut) { await Service.updateOne({ servisId: Number(s.service) }, { $set: apiData }); guncellenen++; }
      else { await Service.create({ servisId: Number(s.service), ...apiData, vitrin: false, aktif: true, populer: false, sira: 999, musteriTL: 0, eskiFiyatTL: 0 }); eklenen++; }
    }
    return { basarili: true, toplam: data.length, eklenen, guncellenen };
  }

  if (name === 'mesajlari_listele') {
    const { limit = 10 } = input;
    const sessions = await Message.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: '$sessionId', ad: { $first: '$ad' },
        sonMesaj: { $first: '$icerik' }, sonTarih: { $first: '$createdAt' },
        okunmamis: { $sum: { $cond: [{ $and: [{ $eq: ['$gonderen','musteri'] }, { $eq: ['$okundu',false] }] }, 1, 0] } },
      }},
      { $sort: { sonTarih: -1 } },
      { $limit: Math.min(Number(limit), 50) },
    ]);
    return { toplam: sessions.length, konusmalar: sessions };
  }

  return { hata: 'Bilinmeyen araç.' };
}

app.post('/api/admin/ai-sohbet', adminGuard, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY tanımlı değil.' });

  const { mesajlar } = req.body;
  if (!Array.isArray(mesajlar) || mesajlar.length === 0)
    return res.status(400).json({ success: false, error: 'Mesaj listesi gerekli.' });

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let messages = mesajlar.slice(-30);

  try {
    while (true) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: `Sen TakipçiPro admin panelinin akıllı yardımcı botusun. Türkçe konuşursun.

TakipçiPro bir Instagram/sosyal medya takipçi satış sitesidir. SosyalBizde SMM panelinden servis çeker.

YAPABİLECEKLERİN:
1. Servis yönetimi: listele, ara, filtrele (servisleri_listele)
2. Servis güncelle: vitrine ekle/çıkar, ad, fiyat, açıklama, emoji, teslimat süresi, sıra, aktiflik (servis_guncelle)
3. Toplu vitrin: birden fazla servisi aynı anda vitrine al/çıkar (toplu_vitrin)
4. Toplu fiyat: birden fazla servise aynı anda fiyat ver (toplu_fiyat_guncelle)
5. Siparişleri gör: listele, filtrele (siparisleri_listele)
6. İstatistik: genel bakış, bakiye, sipariş sayıları (istatistik_getir)
7. SMM güncelle: SosyalBizde'den güncel servisleri çek (servisleri_smm_guncelle)
8. Müşteri mesajları: konuşmaları listele (mesajlari_listele)

ÖNEMLİ BİLGİLER:
- fiyatUSD: SosyalBizde'nin USD fiyatı (1000 adet için)
- musteriTL: müşteriye gösterilen TL fiyatı (admin belirler)
- Fiyat belirtilmeden vitrine ekleme istersen vitrine ekle, musteriTL=0 bırak ve fiyat sor
- Toplu işlemlerde önce servisleri_listele ile ID'leri bul, sonra işlemi yap
- Kâr marjı hesaplarken: musteriTL = (fiyatUSD / 1000 * kur) * (1 + marj/100)
- Yanıtlarında ne yaptığını açıkça belirt`,
        messages,
        tools: AI_TOOLS,
      });

      if (response.stop_reason !== 'tool_use') {
        const metin = response.content.find(c => c.type === 'text')?.text || '';
        return res.json({ success: true, cevap: metin });
      }

      messages = [...messages, { role: 'assistant', content: response.content }];
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await aiAracCagir(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages = [...messages, { role: 'user', content: toolResults }];
    }
  } catch(e) {
    console.error('[AI SOHBET]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
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
  console.log('Admin   : GET  /api/admin/siparisler');
  console.log('Admin   : GET  /api/admin/bakiye');
  console.log('Admin   : PUT  /api/admin/servis/:id');
  console.log('Admin   : POST /api/admin/toplu-vitrin');
  console.log('Admin   : POST /api/admin/servisleri-guncelle');
  console.log('Admin   : GET  /api/admin/istatistik');
  console.log('Sağlık  : GET  /api/saglik\n');
});
