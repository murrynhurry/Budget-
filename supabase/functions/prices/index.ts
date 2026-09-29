// Supabase Edge Function "prices": returns live prices from Twelve Data.
// The API key stays on the server in the TWELVE_DATA_API_KEY secret.
// Symbols: "AAPL" (U.S.), "XEQT:TSX", "ABC:TSXV", "XYZ:NEO", and "USD/CAD" for the exchange rate.
const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
const TTL = 15 * 60_000;      // reuse a price for 15 minutes
const PER_CALL = 8;           // free plan allows 8 symbols per minute
const cache = new Map<string, { p: number; t: number }>();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY) return json({ error: "TWELVE_DATA_API_KEY is not set" }, 500);
  try {
    const { symbols } = await req.json();
    const syms = [...new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s).trim().toUpperCase()))]
      .filter((s) => /^[A-Z0-9.\-]{1,12}(:(TSX|TSXV|NEO))?$|^USD\/CAD$/.test(s)).slice(0, 40);
    const now = Date.now(), prices: Record<string, unknown> = {}, need: string[] = [];
    for (const s of syms) {
      const c = cache.get(s);
      if (c && now - c.t < TTL) prices[s] = c; else need.push(s);
    }
    const batch = need.slice(0, PER_CALL);
    if (batch.length) {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(batch.join(","))}&apikey=${KEY}`);
      const j = await r.json();
      for (const s of batch) {
        const v = batch.length === 1 ? j : j?.[s];
        const p = parseFloat(v?.price);
        if (p > 0) { const e = { p, t: now }; cache.set(s, e); prices[s] = e; }
        else prices[s] = { error: v?.message || j?.message || "No price" };
      }
    }
    for (const s of need.slice(PER_CALL)) prices[s] = { error: "Rate limited, try again in a minute" };
    return json({ prices, at: now });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
