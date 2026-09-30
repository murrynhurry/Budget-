// Supabase Edge Function "recipe-import": reads a recipe from a web page link for Recipe Box.
// Free: no AI and no API key. Most cooking sites publish their recipe in a standard
// hidden format (schema.org "Recipe" data) for search engines; this reads that.
// Only signed-in members of a shared space can use it.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const decode = (s: string) => s
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, " ").trim();

// "PT1H10M" -> "1 hr 10 min"
function duration(v: unknown): string {
  const m = String(v || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return "";
  const mins = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  if (!mins) return "";
  const h = Math.floor(mins / 60), mm = mins % 60;
  return [h ? `${h} hr` : "", mm ? `${mm} min` : ""].filter(Boolean).join(" ");
}
const isRecipe = (o: any) => o && (o["@type"] === "Recipe" || (Array.isArray(o["@type"]) && o["@type"].includes("Recipe")));
function findRecipe(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  if (isRecipe(node)) return node;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) { const r = findRecipe(node[k]); if (r) return r; }
  return null;
}
function steps(ins: any): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (!x) return;
    if (typeof x === "string") { x.split(/\n+/).map(decode).filter(Boolean).forEach((t) => out.push(t.replace(/^\d+[.)]\s*/, ""))); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x["@type"] === "HowToSection" || (Array.isArray(x["@type"]) && x["@type"].includes("HowToSection"))) {
      if (x.name) out.push("# " + decode(String(x.name)));
      walk(x.itemListElement); return;
    }
    if (x.text) out.push(decode(String(x.text)));
    else if (x.name) out.push(decode(String(x.name)));
    else if (x.itemListElement) walk(x.itemListElement);
  };
  walk(ins);
  return out.filter(Boolean).slice(0, 60);
}
function tags(r: any): string[] {
  const bits: string[] = [];
  for (const k of ["recipeCategory", "recipeCuisine", "keywords"]) {
    const v = r[k]; if (!v) continue;
    (Array.isArray(v) ? v : String(v).split(",")).forEach((x: unknown) => bits.push(decode(String(x)).toLowerCase()));
  }
  return [...new Set(bits.filter((t) => t && t.length <= 20))].slice(0, 4);
}
function servings(v: unknown): number | null {
  const s = Array.isArray(v) ? v.join(" ") : String(v ?? "");
  const m = s.match(/\d+/); return m ? Number(m[0]) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "Sign in to import recipes." }, 401);

    const { url } = await req.json();
    let target: URL;
    try { target = new URL(String(url)); } catch { return json({ error: "That link doesn't look right." }, 400); }
    if (!/^https?:$/.test(target.protocol)) return json({ error: "That link doesn't look right." }, 400);

    const page = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Accept": "text/html" }, redirect: "follow" });
    if (!page.ok) return json({ error: `That site didn't let us in (error ${page.status}).` }, 422);
    const html = (await page.text()).slice(0, 3_000_000);

    let recipe: any = null;
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch { /* some sites have broken blocks; try the next */ }
      if (recipe) break;
    }
    if (!recipe) return json({ error: "Couldn't find a recipe on that page." }, 422);

    const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
      .map((x: unknown) => decode(String(x))).filter(Boolean).slice(0, 80);
    return json({
      recipe: {
        title: decode(String(recipe.name || "")) || "Untitled recipe",
        servings: servings(recipe.recipeYield),
        prepTime: duration(recipe.prepTime),
        cookTime: duration(recipe.cookTime),
        totalTime: duration(recipe.totalTime),
        tags: tags(recipe),
        ingredients,
        steps: steps(recipe.recipeInstructions),
        notes: "",
      },
    });
  } catch (e) {
    return json({ error: "Couldn't read that link: " + String((e as any)?.message || e) }, 500);
  }
});
