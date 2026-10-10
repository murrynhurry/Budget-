// Supabase Edge Function "notify": sends a phone notification to your partner in Murry & Matty.
// The app calls it after you post a love note, suggest a plan, answer one, or add a chore for them.
// Only signed-in members of a shared space can use it, and it only notifies people in that space.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC = "BEECd2ut3X4K9nx4QhhhXIzO_mTwX7jvo8KFmysvkgaFrtbuZyPvCSE4dbabbgw4itRkpbz8mBZlsU9yO7rY3dU";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!VAPID_PRIVATE) return json({ error: "Notifications aren't set up yet." }, 500);
    webpush.setVapidDetails("mailto:murry-and-matty@example.com", VAPID_PUBLIC, VAPID_PRIVATE);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    const me = u?.user?.id;
    if (!me) return json({ error: "Sign in first." }, 401);

    const m = await sb.from("household_members").select("household_id,joined_at").eq("user_id", me).order("joined_at", { ascending: false }).limit(1);
    const hid = m.data?.[0]?.household_id;
    if (!hid) return json({ sent: 0 });

    const b = await req.json().catch(() => ({}));
    const payload = JSON.stringify({ title: clip(b.title, 80) || "Murry & Matty", body: clip(b.body, 180), tag: clip(b.tag, 60), url: clip(b.url, 200) || "./" });

    const rows = await sb.from("recipe_docs").select("id,data").eq("household_id", hid).eq("coll", "mm_push");
    let sent = 0;
    for (const row of rows.data ?? []) {
      if (row.id === me) continue; // never notify yourself
      const subs: any[] = Array.isArray(row.data?.subs) ? row.data.subs : [];
      const keep: any[] = [];
      for (const s of subs) {
        try { await webpush.sendNotification(s, payload, { TTL: 60 * 60 * 24 }); sent++; keep.push(s); }
        catch (e) { const code = (e as any)?.statusCode; if (code !== 404 && code !== 410) keep.push(s); }
      }
      if (keep.length !== subs.length) {
        await sb.from("recipe_docs").upsert({ household_id: hid, coll: "mm_push", id: row.id, data: { ...row.data, subs: keep }, updated_at: new Date().toISOString() });
      }
    }
    return json({ sent });
  } catch (e) {
    return json({ error: "Couldn't send: " + String((e as any)?.message || e) }, 500);
  }
});
