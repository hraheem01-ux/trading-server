import "dotenv/config";
import express from "express";
import cors from "cors";
import { Resend } from "resend";

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// لمنع تكرار الإيميلات
const lastAlerts = {};

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

app.listen(3001, () => {
  console.log("🚀 Email server running on http://localhost:3001");
});