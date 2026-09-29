// Supabase Edge Function "prices": live prices for the budget app.
// 1) Twelve Data (key in the TWELVE_DATA_API_KEY secret, never sent to the phone).
// 2) Anything Twelve Data can't price (e.g. TSX on its free plan) falls back to Yahoo Finance's public quote data.
// Symbols: "AAPL" (U.S.), "XEQT:TSX", "ABC:TSXV", "XYZ:NEO", and "USD/CAD".
const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
const TTL = 15 * 60_000;      // reuse a price for 15 minutes
const PER_CALL = 8;           // Twelve Data free plan: 8 symbols per minute
const cache = new Map<string, { p: number; t: number }>();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const yahooSym = (s: string) =>
  s === "USD/CAD" ? "CAD=X" : s.replace(/:TSXV$/, ".V").replace(/:TSX$/, ".TO").replace(/:NEO$/, ".NE");

async function twelve(batch: string[]) {
  const out: Record<string, number> = {};
  if (!KEY || !batch.length) return out;
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(batch.join(","))}&apikey=${KEY}`);
    const j = await r.json();
    for (const s of batch) { const p = parseFloat((batch.length === 1 ? j : j?.[s])?.price); if (p > 0) out[s] = p; }
  } catch (_) { /* fall through to Yahoo */ }
  return out;
}
async function yahoo(s: string) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym(s))}?range=1d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" } });
    const p = parseFloat((await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice);
    return p > 0 ? p : null;
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { symbols } = await req.json();
    const syms = [...new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s).trim().toUpperCase()))]
      .filter((s) => /^[A-Z0-9.\-]{1,12}(:(TSX|TSXV|NEO))?$|^USD\/CAD$/.test(s)).slice(0, 40);
    const now = Date.now(), prices: Record<string, unknown> = {}, need: string[] = [];
    for (const s of syms) { const c = cache.get(s); if (c && now - c.t < TTL) prices[s] = c; else need.push(s); }
    const got = await twelve(need.slice(0, PER_CALL));
    await Promise.all(need.map(async (s) => {
      const p = got[s] ?? await yahoo(s);
      if (p) { const e = { p, t: now }; cache.set(s, e); prices[s] = e; } else prices[s] = { error: "No price found for " + s };
    }));
    return json({ prices, at: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
