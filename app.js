const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// SENİN BİLGİLERİN
const API_KEY = "8ec63def79ea6bf2ce5508d14c9e85ed";
const API_URL = "https://sosyalbizde.com/api/v2";
const TELEGRAM_TOKEN = "8543277332:AAGAKVT0P_WNIk1r1WXVHZaSWvUi6nrTATY7";
const CHAT_ID = "1951697589";

// TELEGRAM BİLDİRİM FONKSİYONU
async function bildirimGonder(mesaj) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: `🚨 TAKİPÇİPRO BİLDİRİM:\n\n${mesaj}`
        });
    } catch (err) {
        console.log("Telegram hatası! Botu başlattığından emin ol.");
    }
}

// SİPARİŞ VE BAKİYE KONTROLÜ
app.post('/api/siparis-ver', async (req, res) => {
    const { servisId, link, miktar, kategori } = req.body;

    try {
        // 1. Bakiyeni Sorgula
        const bakiyeRes = await axios.post(API_URL, { key: API_KEY, action: 'balance' });
        const benimBakiyem = parseFloat(bakiyeRes.data.balance);

        // 2. Servis Bilgisini Çek
        const data = JSON.parse(fs.readFileSync('services.json', 'utf8'));
        let urun = null;

        if (Array.isArray(data)) {
            urun = data.find(s => s.id == servisId) || null;
        } else {
            for (let kat in data) {
                let bul = data[kat].find(s => s.id == servisId);
                if (bul) urun = bul;
            }
        }

        if (!urun) return res.status(404).json({ hata: "Servis bulunamadı!" });

        const birimFiyat = Number(urun.api_price ?? urun.price ?? 0);
        const maliyet = (birimFiyat / 1000) * miktar;

        // 3. BAKİYE KONTROLÜ (GÜVENLİK)
        if (benimBakiyem < maliyet) {
            const mesaj = `❌ BAKİYE BİTTİ!\nMüşteri ${miktar} adet ${urun.name} bekliyor.\nMaliyet: ${maliyet.toFixed(2)} TL\nSenin Bakiye: ${benimBakiyem.toFixed(2)} TL\n\nACİL YÜKLEME YAP!`;
            await bildirimGonder(mesaj);
            return res.json({ durum: "beklemede", mesaj: "Yönetici onayı bekleniyor." });
        }

        // 4. HESAP SATIŞI BİLDİRİMİ
        if (kategori === "HESAP_SATISI") {
            await bildirimGonder(`💰 HESAP SATILDI!\nÜrün: ${urun.name}\nMüşteri İletişim: ${link}\nHesabı manuel teslim et!`);
            return res.json({ durum: "tamam", mesaj: "İşlem onaylandı, bilgiler iletilecek." });
        }

        // 5. OTOMATİK API GÖNDERİMİ
        const apiRes = await axios.post(API_URL, {
            key: API_KEY, action: 'add', service: servisId, link: link, quantity: miktar
        });

        if (apiRes.data.order) {
            await bildirimGonder(`✅ SİPARİŞ GEÇİLDİ!\nÜrün: ${urun.name}\nMiktar: ${miktar}\nKalan Bakiyen: ${(benimBakiyem - maliyet).toFixed(2)} TL`);
            res.json({ durum: "basarili", no: apiRes.data.order });
        } else {
            res.json({ durum: "hata", mesaj: apiRes.data.error });
        }

    } catch (err) {
        res.status(500).json({ hata: "Sistem hatası!" });
    }
});

app.listen(3000, () => {
    console.log("TakipçiPro 3000 Portunda Aktif!");
});