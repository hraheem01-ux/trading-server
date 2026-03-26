import "dotenv/config";
import express from "express";
import cors from "cors";
import { Resend } from "resend";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// الأسهم اللي نراقبها
const SYMBOLS = ["TSLA", "NVDA", "RUN", "SOFI"];

// منع التكرار
const lastAlerts = {};

// ===============================
// API إرسال التنبيهات
// ===============================
app.post("/api/send-alert", async (req, res) => {
  try {
    const { symbol, decision, confidence, price, email } = req.body;

    if (confidence < 90) {
      return res.json({ ok: false, reason: "confidence منخفض" });
    }

    if (!["شراء", "بيع"].includes(decision)) {
      return res.json({ ok: false, reason: "قرار غير صالح" });
    }

    const key = `${symbol}-${decision}`;

    if (lastAlerts[symbol] === key) {
      return res.json({ ok: true, skipped: true });
    }

    const result = await resend.emails.send({
      from: "Trading Alerts <onboarding@resend.dev>",
      to: [email],
      subject: `🔥 ${decision} ${symbol} بنسبة ${confidence}%`,
      html: `
        <div style="font-family:Arial; direction:rtl">
          <h2>🚨 تنبيه تداول</h2>
          <p>السهم: <b>${symbol}</b></p>
          <p>القرار: <b>${decision}</b></p>
          <p>الثقة: <b>${confidence}%</b></p>
          <p>السعر: <b>$${price}</b></p>
        </div>
      `,
    });

    lastAlerts[symbol] = key;

    res.json({ ok: true, result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// ===============================
// 🔥 المراقبة التلقائية
// ===============================
async function checkMarket() {
  try {
    for (const symbol of SYMBOLS) {

      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
      );
      const data = await res.json();

      const price =
        data.chart.result[0].meta.regularMarketPrice;

      console.log(`📊 ${symbol}:`, price);

      // تحليل بسيط (تقدر تطوره لاحقًا)
      const decision = price > 200 ? "بيع" : "شراء";
      const confidence = 92;

      const key = `${symbol}-${decision}`;

      if (lastAlerts[symbol] === key) {
        console.log(`⏭️ ${symbol} تم تخطي التكرار`);
        continue;
      }

      if (confidence >= 90) {
        await resend.emails.send({
          from: "Trading Alerts <onboarding@resend.dev>",
          to: ["hraheem01@gmail.com"], // ⚠️ حط ايميلك
          subject: `🔥 ${decision} ${symbol} بنسبة ${confidence}%`,
          html: `
            <div style="font-family:Arial; direction:rtl">
              <h2>🚨 تنبيه تلقائي</h2>
              <p>السهم: <b>${symbol}</b></p>
              <p>القرار: <b>${decision}</b></p>
              <p>الثقة: <b>${confidence}%</b></p>
              <p>السعر: <b>$${price}</b></p>
            </div>
          `,
        });

        console.log(`📧 تم إرسال تنبيه لـ ${symbol}`);

        lastAlerts[symbol] = key;
      }
    }

  } catch (err) {
    console.error("❌ خطأ في السوق:", err);
  }
}

// ⏱️ كل دقيقة
setInterval(checkMarket, 60000);

// ===============================
// تشغيل السيرفر
// ===============================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
