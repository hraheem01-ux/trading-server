import "dotenv/config";
import express from "express";
import cors from "cors";
import { Resend } from "resend";

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const ALERT_EMAIL = "Hraheem01@gmail.com";
const SYMBOLS = ["TSLA", "NVDA", "RUN", "SOFI"];
const CHECK_INTERVAL_MS = 120000; // كل دقيقتين
const lastAlerts = {};

// ===============================
// أدوات مساعدة
// ===============================
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function formatPrice(value) {
  return Number(value).toFixed(2);
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function sma(values, period) {
  if (values.length < period) return average(values);
  return average(values.slice(-period));
}

// ===============================
// تحويل بيانات Yahoo إلى شموع منظمة
// ===============================
function buildBarsFromYahoo(data) {
  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};

  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const bars = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = opens[i];
    const high = highs[i];
    const low = lows[i];
    const close = closes[i];
    const volume = volumes[i];

    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      volume == null
    ) {
      continue;
    }

    bars.push({
      time: timestamps[i],
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    });
  }

  return bars;
}

// ===============================
// Anchored VWAP
// ===============================
function findAnchorIndex(bars) {
  if (bars.length < 10) return 0;

  // نأخذ آخر 20 شمعة ونبحث عن آخر قاع/قمة مهمين
  const lookback = Math.min(20, bars.length - 1);
  const slice = bars.slice(-lookback);

  let lowestIndex = 0;
  let highestIndex = 0;

  for (let i = 1; i < slice.length; i++) {
    if (slice[i].low < slice[lowestIndex].low) lowestIndex = i;
    if (slice[i].high > slice[highestIndex].high) highestIndex = i;
  }

  // نختار الأحدث بينهما كمرساة حديثة
  const recentIndex = Math.max(lowestIndex, highestIndex);

  return bars.length - lookback + recentIndex;
}

function calculateAnchoredVWAP(bars, anchorIndex) {
  const sliced = bars.slice(anchorIndex);

  let pv = 0;
  let vol = 0;

  for (const bar of sliced) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    pv += typicalPrice * bar.volume;
    vol += bar.volume;
  }

  if (!vol) return bars[bars.length - 1]?.close ?? 0;
  return pv / vol;
}

// ===============================
// Volume Profile approximation
// ===============================
function calculateVolumeProfile(bars, bins = 24) {
  if (!bars.length) {
    return {
      poc: 0,
      vah: 0,
      val: 0,
      hvn: [],
      lvn: [],
    };
  }

  const allHigh = Math.max(...bars.map((b) => b.high));
  const allLow = Math.min(...bars.map((b) => b.low));

  if (allHigh === allLow) {
    return {
      poc: allHigh,
      vah: allHigh,
      val: allLow,
      hvn: [allHigh],
      lvn: [allLow],
    };
  }

  const step = (allHigh - allLow) / bins;
  const profile = new Array(bins).fill(0);

  for (const bar of bars) {
    const price = (bar.high + bar.low + bar.close) / 3;
    let idx = Math.floor((price - allLow) / step);
    idx = clamp(idx, 0, bins - 1);
    profile[idx] += bar.volume;
  }

  const totalVolume = sum(profile);
  const pocIndex = profile.indexOf(Math.max(...profile));

  let covered = profile[pocIndex];
  let left = pocIndex;
  let right = pocIndex;

  while (covered < totalVolume * 0.7 && (left > 0 || right < bins - 1)) {
    const leftVol = left > 0 ? profile[left - 1] : -1;
    const rightVol = right < bins - 1 ? profile[right + 1] : -1;

    if (rightVol >= leftVol) {
      right++;
      covered += profile[right];
    } else {
      left--;
      covered += profile[left];
    }
  }

  const poc = allLow + (pocIndex + 0.5) * step;
  const vah = allLow + (right + 0.5) * step;
  const val = allLow + (left + 0.5) * step;

  const sorted = [...profile]
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v);

  const hvn = sorted
    .slice(0, 3)
    .map((x) => allLow + (x.i + 0.5) * step);

  const lvn = [...profile]
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v)
    .slice(0, 3)
    .map((x) => allLow + (x.i + 0.5) * step);

  return { poc, vah, val, hvn, lvn };
}

// ===============================
// Order Flow approximation
// ===============================
function calculateOrderFlowApprox(bars) {
  const recent = bars.slice(-8);

  let buyPressure = 0;
  let sellPressure = 0;

  for (const bar of recent) {
    const range = Math.max(bar.high - bar.low, 0.0001);
    const body = Math.abs(bar.close - bar.open);
    const closeLocation = (bar.close - bar.low) / range; // 0 إلى 1
    const impulse = (body / range) * bar.volume;

    buyPressure += impulse * closeLocation;
    sellPressure += impulse * (1 - closeLocation);
  }

  const total = buyPressure + sellPressure || 1;
  const delta = (buyPressure - sellPressure) / total;

  return {
    buyPressure,
    sellPressure,
    delta, // موجب = ضغط شرائي
  };
}

// ===============================
// Liquidity Sweep approximation
// ===============================
function detectLiquiditySweep(bars) {
  if (bars.length < 8) {
    return {
      buySweep: false,
      sellSweep: false,
    };
  }

  const current = bars[bars.length - 1];
  const previousRange = bars.slice(-7, -1);

  const prevHigh = Math.max(...previousRange.map((b) => b.high));
  const prevLow = Math.min(...previousRange.map((b) => b.low));

  // سحب سيولة أعلى: اخترق قمة ثم رجع وأغلق تحتها
  const sellSweep =
    current.high > prevHigh &&
    current.close < prevHigh &&
    current.close < current.open;

  // سحب سيولة أسفل: كسر قاع ثم رجع وأغلق فوقه
  const buySweep =
    current.low < prevLow &&
    current.close > prevLow &&
    current.close > current.open;

  return {
    buySweep,
    sellSweep,
    prevHigh,
    prevLow,
  };
}

// ===============================
// التحليل الرئيسي
// ===============================
function analyzeSymbol(symbol, bars) {
  const current = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);

  const currentPrice = current.close;
  const sma20Value = sma(closes, 20);
  const sma50Value = sma(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const avgVol20 = sma(volumes, 20);
  const volumeRatio = avgVol20 ? current.volume / avgVol20 : 1;

  const anchorIndex = findAnchorIndex(bars);
  const anchoredVWAP = calculateAnchoredVWAP(bars, anchorIndex);

  const vp = calculateVolumeProfile(bars, 24);
  const orderFlow = calculateOrderFlowApprox(bars);
  const sweep = detectLiquiditySweep(bars);

  const trendUp = currentPrice > sma20Value && sma20Value > sma50Value;
  const trendDown = currentPrice < sma20Value && sma20Value < sma50Value;

  const aboveAVWAP = currentPrice > anchoredVWAP;
  const belowAVWAP = currentPrice < anchoredVWAP;

  const nearPOC = Math.abs(currentPrice - vp.poc) / currentPrice < 0.004;
  const aboveVAH = currentPrice > vp.vah;
  const belowVAL = currentPrice < vp.val;

  let buyScore = 0;
  let sellScore = 0;
  const buyReasons = [];
  const sellReasons = [];

  // الاتجاه
  if (trendUp) {
    buyScore += 20;
    buyReasons.push("الاتجاه العام صاعد");
  }
  if (trendDown) {
    sellScore += 20;
    sellReasons.push("الاتجاه العام هابط");
  }

  // Anchored VWAP
  if (aboveAVWAP) {
    buyScore += 15;
    buyReasons.push("السعر فوق Anchored VWAP");
  }
  if (belowAVWAP) {
    sellScore += 15;
    sellReasons.push("السعر تحت Anchored VWAP");
  }

  // Order Flow approximation
  if (orderFlow.delta > 0.18) {
    buyScore += 15;
    buyReasons.push("ضغط شرائي واضح");
  }
  if (orderFlow.delta < -0.18) {
    sellScore += 15;
    sellReasons.push("ضغط بيعي واضح");
  }

  // Volume Profile approximation
  if (aboveVAH) {
    buyScore += 12;
    buyReasons.push("فوق Value Area High");
  }
  if (belowVAL) {
    sellScore += 12;
    sellReasons.push("تحت Value Area Low");
  }

  if (nearPOC) {
    buyScore -= 4;
    sellScore -= 4;
  }

  // Liquidity sweep
  if (sweep.buySweep) {
    buyScore += 18;
    buyReasons.push("سحب سيولة سفلي");
  }
  if (sweep.sellSweep) {
    sellScore += 18;
    sellReasons.push("سحب سيولة علوي");
  }

  // RSI
  if (rsi >= 52 && rsi <= 68) {
    buyScore += 8;
    buyReasons.push("RSI داعم للصعود");
  }
  if (rsi <= 48 && rsi >= 32) {
    sellScore += 8;
    sellReasons.push("RSI داعم للهبوط");
  }

  // الحجم
  if (volumeRatio > 1.15 && current.close > prev.close) {
    buyScore += 10;
    buyReasons.push("حجم داعم للصعود");
  }
  if (volumeRatio > 1.15 && current.close < prev.close) {
    sellScore += 10;
    sellReasons.push("حجم داعم للهبوط");
  }

  // شروط تشدد قوية للوصول إلى +90
  const hardBuyPass =
    trendUp &&
    aboveAVWAP &&
    orderFlow.delta > 0.18 &&
    (sweep.buySweep || aboveVAH) &&
    volumeRatio > 1.05;

  const hardSellPass =
    trendDown &&
    belowAVWAP &&
    orderFlow.delta < -0.18 &&
    (sweep.sellSweep || belowVAL) &&
    volumeRatio > 1.05;

  if (!hardBuyPass) buyScore = Math.min(buyScore, 89);
  if (!hardSellPass) sellScore = Math.min(sellScore, 89);

  buyScore = clamp(Math.round(buyScore), 0, 99);
  sellScore = clamp(Math.round(sellScore), 0, 99);

  let decision = "انتظار";
  let confidence = Math.max(buyScore, sellScore);
  let reasons = ["الشروط القوية غير مكتملة"];

  if (buyScore >= 90 && buyScore >= sellScore + 12) {
    decision = "شراء";
    confidence = buyScore;
    reasons = buyReasons.slice(0, 4);
  } else if (sellScore >= 90 && sellScore >= buyScore + 12) {
    decision = "بيع";
    confidence = sellScore;
    reasons = sellReasons.slice(0, 4);
  }

  return {
    symbol,
    decision,
    confidence,
    price: currentPrice,
    buyScore,
    sellScore,
    rsi: Number(rsi.toFixed(2)),
    sma20: Number(sma20Value.toFixed(2)),
    sma50: Number(sma50Value.toFixed(2)),
    anchoredVWAP: Number(anchoredVWAP.toFixed(2)),
    poc: Number(vp.poc.toFixed(2)),
    vah: Number(vp.vah.toFixed(2)),
    val: Number(vp.val.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    orderFlowDelta: Number(orderFlow.delta.toFixed(3)),
    reasons,
  };
}

// ===============================
// الإيميل
// ===============================
async function sendSignalEmail(signal) {
  const {
    symbol,
    decision,
    confidence,
    price,
    rsi,
    sma20,
    sma50,
    anchoredVWAP,
    poc,
    vah,
    val,
    volumeRatio,
    orderFlowDelta,
    reasons,
  } = signal;

  return resend.emails.send({
    from: "Trading Alerts <onboarding@resend.dev>",
    to: [ALERT_EMAIL],
    subject: `🔥 ${decision} ${symbol} بنسبة ${confidence}%`,
    html: `
      <div style="font-family:Arial, sans-serif; direction:rtl; text-align:right; line-height:1.9;">
        <h2>🚨 تنبيه تداول احترافي</h2>
        <p><strong>السهم:</strong> ${symbol}</p>
        <p><strong>القرار:</strong> ${decision}</p>
        <p><strong>الثقة:</strong> ${confidence}%</p>
        <p><strong>السعر الحالي:</strong> $${formatPrice(price)}</p>

        <hr />

        <p><strong>RSI:</strong> ${rsi}</p>
        <p><strong>SMA20:</strong> ${sma20}</p>
        <p><strong>SMA50:</strong> ${sma50}</p>
        <p><strong>Anchored VWAP:</strong> ${anchoredVWAP}</p>
        <p><strong>POC:</strong> ${poc}</p>
        <p><strong>VAH:</strong> ${vah}</p>
        <p><strong>VAL:</strong> ${val}</p>
        <p><strong>Volume Ratio:</strong> ${volumeRatio}x</p>
        <p><strong>Order Flow Delta:</strong> ${orderFlowDelta}</p>

        <hr />

        <p><strong>أسباب القرار:</strong></p>
        <ul style="padding-right:20px; margin:0;">
          ${reasons.map((reason) => `<li>${reason}</li>`).join("")}
        </ul>
      </div>
    `,
  });
}

// ===============================
// API يدوي للاختبار
// ===============================
app.get("/", (req, res) => {
  res.send("Trading server is running");
});

app.post("/api/send-alert", async (req, res) => {
  try {
    const { symbol, decision, confidence, price, email, reasons = [] } = req.body;

    if (Number(confidence) < 90) {
      return res.json({ ok: false, reason: "confidence منخفض" });
    }

    if (!["شراء", "بيع"].includes(decision)) {
      return res.json({ ok: false, reason: "قرار غير صالح" });
    }

    const key = `${symbol}-${decision}-${confidence}`;

    if (lastAlerts[symbol] === key) {
      return res.json({ ok: true, skipped: true });
    }

    const result = await resend.emails.send({
      from: "Trading Alerts <onboarding@resend.dev>",
      to: [email || ALERT_EMAIL],
      subject: `🔥 ${decision} ${symbol} بنسبة ${confidence}%`,
      html: `
        <div style="font-family:Arial, sans-serif; direction:rtl; text-align:right;">
          <h2>🚨 تنبيه يدوي</h2>
          <p><strong>السهم:</strong> ${symbol}</p>
          <p><strong>القرار:</strong> ${decision}</p>
          <p><strong>الثقة:</strong> ${confidence}%</p>
          <p><strong>السعر:</strong> $${price}</p>
          <p><strong>الأسباب:</strong> ${reasons.join(" + ")}</p>
        </div>
      `,
    });

    lastAlerts[symbol] = key;

    res.json({ ok: true, result });
  } catch (err) {
    console.error("manual send error:", err);
    res.status(500).json({ ok: false, reason: err?.message || "server error" });
  }
});

// ===============================
// جلب وتحليل السوق
// ===============================
async function fetchYahooBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=15m&includePrePost=false`;
  const response = await fetch(url);
  const data = await response.json();
  return buildBarsFromYahoo(data);
}

async function checkMarket() {
  try {
    for (const symbol of SYMBOLS) {
      const bars = await fetchYahooBars(symbol);

      if (bars.length < 50) {
        console.log(`⚠️ بيانات غير كافية لـ ${symbol}`);
        continue;
      }

      const signal = analyzeSymbol(symbol, bars);
      console.log(`📊 ${symbol}`, signal);

      const key = `${signal.symbol}-${signal.decision}-${signal.confidence}`;

      if (
        ["شراء", "بيع"].includes(signal.decision) &&
        signal.confidence >= 90 &&
        lastAlerts[symbol] !== key
      ) {
        await sendSignalEmail(signal);
        lastAlerts[symbol] = key;
        console.log(`📧 تم إرسال تنبيه ${signal.decision} لـ ${symbol}`);
      }

      if (signal.decision === "انتظار") {
        lastAlerts[symbol] = null;
      }
    }
  } catch (err) {
    console.error("❌ market check error:", err);
  }
}

// تشغيل أول مرة مباشرة
checkMarket();

// ثم كل دقيقتين
setInterval(checkMarket, CHECK_INTERVAL_MS);

// ===============================
// تشغيل السيرفر
// ===============================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
