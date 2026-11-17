// 시장 자료를 받아 data/ 폴더에 JSON으로 저장 (GitHub Actions가 매시 실행, Node 20)
// series.json: 90일 일별(지표 B 달러·원화, 환율, 시장 심리) / cycles.json: 반감기 사이클 배수 / news.json: 기사 제목(분위기는 data/tone.json에서 붙임)
import fs from "node:fs";

const UA = { "User-Agent": "Mozilla/5.0 market-ops" };
const get = async (url, as = "json") => { const r = await fetch(url, { headers: UA, redirect: "follow" }); if (!r.ok) throw new Error(url + " " + r.status); return as === "json" ? r.json() : r.text(); };
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = new Date();
const fail = [];
const tryGet = async (name, url, as) => { try { return await get(url, as); } catch (e) { fail.push(name); console.error(name, e.message); return null; } };
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
fs.mkdirSync("data", { recursive: true });

// 1) 일별 자료
const usd = await tryGet("coingecko-usd", "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90&interval=daily");
const krw = await tryGet("coingecko-krw", "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=krw&days=90&interval=daily");
const nowp = await tryGet("coingecko-now", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,krw&include_24hr_change=true");
const start = day(now - 95 * 864e5);
const fx = await tryGet("frankfurter", `https://api.frankfurter.dev/v1/${start}..?base=USD&symbols=KRW,JPY`);
const fng = await tryGet("fear-greed", "https://api.alternative.me/fng/?limit=90");
if (usd && nowp) {
  const m = new Map(), put = (d, k, v) => { const r = m.get(d) || { date: d }; r[k] = v; m.set(d, r); };
  usd.prices.forEach(([t, v]) => put(day(t), "b_usd", Math.round(v)));
  (krw?.prices || []).forEach(([t, v]) => put(day(t), "b_krw", Math.round(v)));
  for (const [d, r] of Object.entries(fx?.rates || {})) { put(d, "usdkrw", r.KRW); put(d, "usdjpy", r.JPY); }
  (fng?.data || []).forEach((x) => put(day(+x.timestamp * 1000), "mood", +x.value));
  const rows = [...m.values()].filter((r) => r.b_usd != null).sort((a, b) => a.date.localeCompare(b.date));
  let lk = null, lj = null;
  for (const r of rows) { if (r.usdkrw != null) { lk = r.usdkrw; lj = r.usdjpy; } else { r.usdkrw = lk; r.usdjpy = lj; r.fx_filled = true; } for (const k of ["b_krw", "mood"]) if (r[k] === undefined) r[k] = null; }
  const last = rows[rows.length - 1], b = nowp.bitcoin;
  Object.assign(last, { b_usd_now: b.usd, b_krw_now: b.krw, chg24: Math.round(b.usd_24h_change * 100) / 100 });
  fs.writeFileSync("data/series.json", JSON.stringify({ at: now.toISOString(), rows }));
}

// 2) 반감기 사이클
const hist = await tryGet("blockchain", "https://api.blockchain.info/charts/market-price?timespan=all&format=json&sampled=false");
if (hist && nowp) {
  const v = hist.values.map((p) => ({ d: day(p.x * 1000), t: p.x * 1000, y: p.y })).filter((p) => p.y > 0);
  const H = [["2012", "2012-11-28"], ["2016", "2016-07-09"], ["2020", "2020-05-11"], ["2024", "2024-04-20"]];
  const rows = [];
  H.forEach(([name, hd], i) => {
    const t0 = Date.parse(hd + "T00:00:00Z"), t1 = i + 1 < H.length ? Date.parse(H[i + 1][1] + "T00:00:00Z") : Infinity;
    const seg = v.filter((p) => p.t >= t0 && p.t < t1); const base = seg[0].y, step = name === "2024" ? 2 : 7;
    seg.forEach((p, k) => { if (k % step === 0 || k === seg.length - 1) rows.push({ cycle: name, day: Math.round((p.t - t0) / 864e5), date: p.d, mult: Math.round(p.y / base * 1000) / 1000 }); });
    if (name === "2024") rows.push({ cycle: name, day: Math.round((now - t0) / 864e5), date: day(now), mult: Math.round(nowp.bitcoin.usd / base * 1000) / 1000, now: true });
  });
  fs.writeFileSync("data/cycles.json", JSON.stringify({ at: now.toISOString(), rows }));
}

// 3) 기사 제목(분위기·주제는 data/tone.json — Claude 예약 작업이 채움)
const ent = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const items = [];
const rss = async (name, url, src, lang, n) => {
  const x = await tryGet(name, url, "text"); if (!x) return;
  for (const it of x.split("<item>").slice(1, n + 1)) {
    const g = (t) => { const mm = it.match(new RegExp("<" + t + String.raw`[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</` + t + ">")); return mm ? mm[1].trim() : ""; };
    let title = ent(g("title")), pub = src;
    if (lang === "ko") { const k = title.lastIndexOf(" - "); if (k > 0) { pub = title.slice(k + 3); title = title.slice(0, k); } }
    const d = new Date(g("pubDate"));
    items.push({ time: isNaN(d) ? "" : d.toISOString(), source: pub, title, link: g("link"), lang });
  }
};
await rss("google-news", "https://news.google.com/rss/search?q=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8&hl=ko&gl=KR&ceid=KR:ko", "Google 뉴스", "ko", 20);
// 구글 뉴스는 GitHub Actions에서 자주 막혀 국내 매체 RSS를 함께 받음
await rss("blockmedia", "https://www.blockmedia.co.kr/feed", "블록미디어", "ko", 10);
await rss("tokenpost", "https://www.tokenpost.kr/rss", "토큰포스트", "ko", 10);
await rss("coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk", "en", 10);
await rss("cointelegraph", "https://cointelegraph.com/rss", "Cointelegraph", "en", 10);
if (items.length) {
  items.sort((a, b) => b.time.localeCompare(a.time));
  fs.writeFileSync("data/news.json", JSON.stringify({ at: now.toISOString(), rows: items }));
}

fs.writeFileSync("data/status.json", JSON.stringify({ at: now.toISOString(), failed: fail }));
console.log("done", now.toISOString(), "failed:", fail.join(",") || "none");
