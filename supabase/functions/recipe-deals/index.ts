// Supabase Edge Function "recipe-deals": weekly grocery flyer deals and coupons for Recipe Box.
// Two ways to run it:
//   * From the app ("Check for deals now"): uses the signed-in person's shared space.
//   * From Supabase Cron every Thursday: send the header  x-cron-secret: <CRON_SECRET>  and it updates every space.
// Uses Claude with web search (ANTHROPIC_API_KEY secret). Deals are written to recipe_docs as deals/latest.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const CITY = Deno.env.get("DEALS_CITY") ?? "Edmonton";
const REGION = Deno.env.get("DEALS_REGION") ?? "Alberta";
const MODEL = "claude-haiku-4-5-20251001";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

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

async function findDeals(items: { name: string; group: string }[]) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Someone in ${CITY}, ${REGION}, Canada wants this week's grocery flyer deals and coupons for these items:
${items.map((i) => `- ${i.name} (${i.group})`).join("\n")}

Search the web for current flyer deals and coupons at ${CITY}-area stores (Real Canadian Superstore, No Frills, Save-On-Foods, Sobeys/Safeway, Walmart, Costco, T&T, Shoppers Drug Mart, London Drugs, Dollarama) and digital coupons (PC Optimum, Scene+, Save-On More Rewards, Checkout 51). Flyer pages on flyers-on-line.com are a good source. Only include deals you actually read on a page, with prices exactly as listed; never guess prices or dates.

When you are done, reply with ONLY one JSON object, no other text:
{"summaries": {"fridge": "...", "freezer": "...", "pantry": "...", "household": "..."}, "deals": [{"item": "<exactly one of the item names above>", "store": "...", "deal": "<product and size>", "price": "<as listed, e.g. $4/lb or $1 off>", "validUntil": "YYYY-MM-DD", "type": "flyer" | "digital coupon" | "flyer + points" | "coupon", "url": "<https page where you saw it>"}]}
Each summary is one or two plain sentences on the best buys in that group and when the flyers end, or "" if the group has no items. At most 4 deals per item.`;
  const messages: any[] = [{ role: "user", content: prompt }];
  let content: any[] = [];
  for (let round = 0; round < 4; round++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 6000, messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8,
          user_location: { type: "approximate", city: CITY, region: REGION, country: "CA", timezone: "America/Edmonton" } }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || "Claude request failed");
    content = j.content || [];
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content });
  }
  const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No deals came back");
  const out = JSON.parse(m[0]);
  const names = new Set(items.map((i) => i.name));
  const deals = (Array.isArray(out.deals) ? out.deals : [])
    .filter((d: any) => d && names.has(String(d.item || "").toLowerCase()) && /^https:\/\//.test(String(d.url || "")))
    .map((d: any) => ({ item: String(d.item).toLowerCase(), store: String(d.store || ""), deal: String(d.deal || ""), price: String(d.price || ""),
      validUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(d.validUntil)) ? String(d.validUntil) : "", type: String(d.type || "flyer"), url: String(d.url) }));
  return { summaries: out.summaries && typeof out.summaries === "object" ? out.summaries : {}, deals };
}

async function runFor(sb: any, hid: string) {
  const [stats, shop] = await Promise.all([getDoc(sb, hid, "fridge", "stats"), getDoc(sb, hid, "shopping", "list")]);
  const items = wantedItems(stats, shop);
  if (!items.length) return { hid, skipped: "nothing to check" };
  const found = await findDeals(items);
  const data = { area: CITY, checkedAt: Date.now(), items: items.map((i) => i.name), ...found };
  const w = await sb.from("recipe_docs").upsert({ household_id: hid, coll: "deals", id: "latest", data, updated_at: new Date().toISOString() });
  if (w.error) throw w.error;
  return { hid, deals: found.deals.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY) return json({ error: "Deals aren't set up yet: add the ANTHROPIC_API_KEY secret in Supabase." }, 503);
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
