// Supabase Edge Function "calendar-feed": fetches a calendar's private iCal link for Murry & Matty.
// Phones can't read Google, iCloud or Outlook calendar links directly (the browser blocks it),
// so the app asks this function to fetch the .ics text and hand it back. Free; no API key.
// Only signed-in members of a shared space can use it, and only for calendar hosts.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Calendar services whose private links this will fetch.
const HOSTS = [/(^|\.)google\.com$/i, /(^|\.)icloud\.com$/i, /(^|\.)office365\.com$/i, /(^|\.)outlook\.com$/i, /(^|\.)live\.com$/i, /(^|\.)calendar\.yahoo\.com$/i, /(^|\.)proton\.me$/i, /(^|\.)fastmail\.com$/i];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "Sign in to sync your calendar." }, 401);

    const { url } = await req.json();
    let target: URL;
    try { target = new URL(String(url).trim().replace(/^webcals?:\/\//i, "https://")); }
    catch { return json({ error: "That calendar link doesn't look right." }, 400); }
    if (target.protocol !== "https:") return json({ error: "That calendar link doesn't look right." }, 400);
    if (!HOSTS.some((h) => h.test(target.hostname))) return json({ error: "Use the private link from Google, iCloud or Outlook Calendar." }, 400);

    const res = await fetch(target, { headers: { "User-Agent": "MurryAndMatty/1.0", "Accept": "text/calendar,*/*" }, redirect: "follow" });
    if (res.status === 404 || res.status === 403 || res.status === 401) return json({ error: "That calendar link didn't work. Copy it again from your calendar's settings." }, 422);
    if (!res.ok) return json({ error: `The calendar didn't answer (error ${res.status}). Try again in a minute.` }, 502);
    const ics = (await res.text()).slice(0, 5_000_000);
    if (!/BEGIN:VCALENDAR/i.test(ics)) return json({ error: "That link isn't a calendar feed. Use the iCal (.ics) address." }, 422);
    return json({ ics });
  } catch (e) {
    return json({ error: "Couldn't read that calendar: " + String((e as any)?.message || e) }, 500);
  }
});
