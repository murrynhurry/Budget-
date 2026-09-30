// Supabase Edge Function "recipe-ai": recipe importing and recipe ideas for Recipe Box.
// The Anthropic key lives in the ANTHROPIC_API_KEY secret and never reaches the phone.
// Only signed-in members of a shared space can use it.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODELS: Record<string, string> = {
  quick: "claude-haiku-4-5-20251001",
  default: "claude-sonnet-5-5",
  complex: "claude-sonnet-5-5",
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY) return json({ error: "The recipe helper isn't set up yet: add the ANTHROPIC_API_KEY secret in Supabase." }, 503);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "Sign in to use this." }, 401);
    const m = await sb.from("household_members").select("household_id").eq("user_id", u.user.id).limit(1);
    if (!m.data?.length) return json({ error: "Join or create a shared space first." }, 403);

    const body = await req.json();
    const tier = MODELS[body.tier] ? body.tier : "default";
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, 2)
      .filter((i: any) => i && typeof i.data === "string" && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type))
      .map((i: any) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }));
    let messages: any[];
    if (Array.isArray(body.messages)) {
      messages = body.messages.filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content)
        .map((t: any) => ({ role: t.role, content: t.content }));
    } else {
      messages = [{ role: "user", content: String(body.prompt ?? "") }];
    }
    if (!messages.length || messages.map((t) => t.content).join("").length > 250_000) return json({ error: "Prompt is empty or too long." }, 400);
    if (images.length) {
      const last = messages[messages.length - 1];
      last.content = [...images, { type: "text", text: last.content }];
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELS[tier], max_tokens: 4096, messages }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || "The recipe helper had a problem.", status: r.status }, r.status === 429 ? 429 : 502);
    const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return json({ text, truncated: j.stop_reason === "max_tokens", tier });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
