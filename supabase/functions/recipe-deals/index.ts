// Supabase Edge Function "recipe-deals": weekly flyer deals for Recipe Box. Free, no API key.
// Looks up each buy-often and household item in the flyer search behind the Flipp app
// (unofficial, so it may need fixing if Flipp changes it) and saves the best deals as deals/latest.
//
// Two ways to run it:
//   * From the app ("Check for deals now"): uses the signed-in person's shared space.
//   * From Supabase Cron every Thursday: send the header  x-cron-secret: <CRON_SECRET>  and it updates every space.
// Optional secrets: DEALS_POSTAL (default T5J0N3, downtown Edmonton), DEALS_CITY (default Edmonton).
import { createClient } from "npm:@supabase/supabase-js@2";

const CRON_SECRET = Deno.env.get("CRON_SECRET");
const POSTAL = (Deno.env.get("DEALS_POSTAL") ?? "T5J0N3").replace(/\s+/g, "").toUpperCase();
const CITY = Deno.env.get("DEALS_CITY") ?? "Edmonton";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1).map((w) => w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

type Doc = Record<string, any> | null;
async function getDoc(sb: any, hid: string, coll: string, id: string): Promise<Doc> {
  const r = await sb.from("recipe_docs").select("data").eq("household_id", hid).eq("coll", coll).eq("id", id).maybeSingle();
  return r.data ? r.data.data : null;
}
function wantedItems(stats: Doc, shop: Doc) {
  const where: Record<string, string> = (stats && stats.where) || {};
  const names = new Set<string>((stats?.pinned || []).map(String));
  for (const [k, n] of Object.entries(stats?.counts || {})) if (Number(n) >= 3) names.add(k);
  const items = [...names].map((n) => ({ name: n.toLowerCase(), group: where[n] || "fridge" }));
  for (const h of shop?.household || []) if (h && h.name && !h.done) items.push({ name: String(h.name).toLowerCase(), group: "household" });
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.name) && seen.add(i.name)).slice(0, 25);
}

// One flyer search. Field names follow what the Flipp app's search returns; anything missing is skipped.
async function search(q: string) {
  const url = `https://backflipp.wishabi.com/flipp/items/search?locale=en-ca&postal_code=${encodeURIComponent(POSTAL)}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!r.ok) throw new Error(`flyer search returned ${r.status}`);
  const j = await r.json();
  const list: any[] = Array.isArray(j?.items) ? j.items : Array.isArray(j?.flyer_items) ? j.flyer_items : [];
  return list;
}
const money = (n: unknown) => { const v = Number(n); return isFinite(v) && v > 0 ? "$" + v.toFixed(2) : ""; };

async function dealsFor(item: { name: string; group: string }) {
  const want = words(item.name);
  const today = new Date().toISOString().slice(0, 10);
  const found = (await search(item.name))
    .map((x) => {
      const name = String(x.name || x.item_name || "").trim();
      const store = String(x.merchant_name || x.merchant || "").trim();
      const until = String(x.valid_to || "").slice(0, 10);
      const price = [String(x.pre_price_text || "").trim(), money(x.current_price), String(x.post_price_text || "").trim()].filter(Boolean).join(" ");
      const story = String(x.sale_story || "").trim();
      return { name, store, until, price: price || story, story, cost: Number(x.current_price) || Infinity };
    })
    .filter((x) => x.name && x.store && x.price && (!x.until || x.until >= today))
    // The main word (last one, e.g. "bags" in "trash bags") must match, plus at least half of all the words.
    .filter((x) => { const have = words(x.name); const hits = want.filter((w) => have.includes(w)).length;
      return want.length > 0 && have.includes(want[want.length - 1]) && hits >= Math.ceil(want.length / 2); })
    .sort((a, b) => a.cost - b.cost);
  const out: any[] = [], stores = new Set<string>();
  for (const x of found) {
    if (stores.has(x.store)) continue; stores.add(x.store);
    out.push({ item: item.name, store: x.store, deal: x.name + (x.story && x.story !== x.price ? ` (${x.story})` : ""), price: x.price,
      validUntil: /^\d{4}-\d{2}-\d{2}$/.test(x.until) ? x.until : "", type: "flyer",
      url: `https://flipp.com/en-ca/search/${encodeURIComponent(item.name)}?postal_code=${POSTAL}` });
    if (out.length >= 4) break;
  }
  return out;
}

function summaries(items: { name: string; group: string }[], deals: any[]) {
  const out: Record<string, string> = {};
  const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" });
  for (const g of ["fridge", "freezer", "pantry", "household"]) {
    const names = items.filter((i) => i.group === g).map((i) => i.name);
    if (!names.length) { out[g] = ""; continue; }
    const ds = deals.filter((d) => names.includes(d.item));
    if (!ds.length) { out[g] = "Nothing on sale for these this week."; continue; }
    const best = names.map((n) => ds.find((d) => d.item === n)).filter(Boolean).slice(0, 3)
      .map((d: any) => `${d.item} at ${d.store} (${d.price})`);
    const ends = ds.map((d) => d.validUntil).filter(Boolean).sort()[0];
    out[g] = `Best buys: ${best.join(", ")}.` + (ends ? ` Some deals end ${fmt(ends)}.` : "");
  }
  return out;
}

async function runFor(sb: any, hid: string) {
  const [stats, shop] = await Promise.all([getDoc(sb, hid, "fridge", "stats"), getDoc(sb, hid, "shopping", "list")]);
  const items = wantedItems(stats, shop);
  if (!items.length) return { hid, skipped: "nothing to check" };
  const deals: any[] = [], failed: string[] = [];
  for (const it of items) {
    try { deals.push(...await dealsFor(it)); } catch (_) { failed.push(it.name); }
    await sleep(250);
  }
  if (failed.length === items.length) throw new Error("The flyer search didn't answer. It may have changed.");
  const data = { area: CITY, checkedAt: Date.now(), items: items.map((i) => i.name).filter((n) => !failed.includes(n)), summaries: summaries(items, deals), deals, source: "flipp" };
  const w = await sb.from("recipe_docs").upsert({ household_id: hid, coll: "deals", id: "latest", data, updated_at: new Date().toISOString() });
  if (w.error) throw w.error;
  return { hid, deals: deals.length, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const r = await admin.from("recipe_docs").select("household_id").eq("coll", "fridge").eq("id", "stats");
      const hids: string[] = [...new Set<string>((r.data || []).map((x: any) => String(x.household_id)))];
      const results: unknown[] = [];
      for (const hid of hids) { try { results.push(await runFor(admin, hid)); } catch (e) { results.push({ hid, error: String(e) }); } }
      return json({ results });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "Sign in to check deals." }, 401);
    const m = await sb.from("household_members").select("household_id,joined_at").eq("user_id", u.user.id).order("joined_at", { ascending: false }).limit(1);
    const hid = m.data?.[0]?.household_id;
    if (!hid) return json({ error: "Join or create a shared space first." }, 403);
    return json(await runFor(sb, hid));
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
