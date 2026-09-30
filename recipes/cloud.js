/* Recipe Box cloud sync (Supabase).
   Uses the same accounts and shared space as the budget app, and presents the same
   small storage + helper interface the Claude version of Recipe Box uses, so the app
   code is identical in both places. */
(function(){
"use strict";
const CFG={url:"https://crrkwfolrkaruoolfyqm.supabase.co",key:"sb_publishable_6bIJ88uhx2IkXAj9Gbc_8g_5GByxg19"};
window.CLOUD=null; window.CLOUD_READY=false;
if(!window.supabase)return;

const sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const ref=new URL(CFG.url).hostname.split(".")[0];
let hasSession=false; try{hasSession=!!localStorage.getItem("sb-"+ref+"-auth-token")}catch(e){}
const C=window.CLOUD={sb,signedIn:hasSession,email:null,hid:null,invite:null,ready:Promise.resolve(null)};

C.signIn=async(email,pw)=>{const r=await sb.auth.signInWithPassword({email,password:pw});if(r.error)throw r.error;return r.data};
C.signUp=async(email,pw)=>{const r=await sb.auth.signUp({email,password:pw});if(r.error)throw r.error;
  if(!r.data||!r.data.session)throw new Error("Account made. Check your email to confirm it, then sign in.");return r.data};
C.signOut=async()=>{try{await sb.auth.signOut()}catch(e){}
  try{Object.keys(localStorage).filter(k=>k.indexOf("rb-cache")===0).forEach(k=>localStorage.removeItem(k))}catch(e){}};
C.join=async code=>{const r=await sb.rpc("join_household",{code:String(code||"").trim()});if(r.error)throw r.error;return r.data};

if(!hasSession)return;
window.CLOUD_READY=true;

let uid=null;
const ready=C.ready=sb.auth.getSession().then(({data})=>{const s=data&&data.session;if(!s)return null;uid=s.user.id;C.email=s.user.email;return uid}).catch(()=>null);

/* ---------- shared space ---------- */
async function findHid(){
  if(C.hid)return C.hid;
  const r=await sb.from("household_members").select("household_id,joined_at").eq("user_id",uid).order("joined_at",{ascending:false}).limit(1);
  if(r.error)throw r.error;
  C.hid=r.data&&r.data[0]?r.data[0].household_id:null;
  if(!C.hid){ // first time on any of the apps: make a space, like the budget app does
    const h=await sb.from("households").insert({data:{},created_by:uid}).select("id,invite_code").single(); if(h.error)throw h.error;
    const m=await sb.from("household_members").insert({household_id:h.data.id,user_id:uid}); if(m.error)throw m.error;
    C.hid=h.data.id; C.invite=h.data.invite_code;
  }
  if(!C.invite){const h=await sb.from("households").select("invite_code").eq("id",C.hid).maybeSingle();C.invite=h.data?h.data.invite_code:null}
  return C.hid;
}

/* ---------- documents: an in-memory copy of this space's recipe_docs, kept live ---------- */
const CACHE="rb-cache-docs";
const docs=new Map(); // "coll/id" -> data
try{const c=JSON.parse(localStorage.getItem(CACHE)||"null");if(c)for(const [k,v] of Object.entries(c))docs.set(k,v)}catch(e){}
const saveCache=()=>{try{localStorage.setItem(CACHE,JSON.stringify(Object.fromEntries(docs)))}catch(e){}};
const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
const isObj=x=>x&&typeof x==="object"&&!Array.isArray(x);
const merge=(a,b)=>{const o=Object.assign({},a||{});for(const k in b){o[k]=isObj(b[k])&&isObj(o[k])?merge(o[k],b[k]):b[k]}return o};
const fail=(e,code)=>({code:code||"unavailable",message:String((e&&e.message)||e)});
const snap=(id,data,fromCache)=>({id,exists:data!=null,data:()=>data==null?undefined:clone(data),metadata:{fromCache:!!fromCache,hasPendingWrites:false}});
const docL=new Map(), collL=new Map(); // path -> Set(fn), coll -> Set(fn)
function qsnap(coll,fromCache){
  const list=[...docs.entries()].filter(([k])=>k.startsWith(coll+"/")).map(([k,v])=>snap(k.slice(coll.length+1),v,fromCache));
  return {docs:list,size:list.length,empty:!list.length,docChanges:()=>[],metadata:{fromCache:!!fromCache,hasPendingWrites:false}};
}
function notify(path,fromCache){
  const coll=path.split("/")[0];
  queueMicrotask(()=>{
    (docL.get(path)||[]).forEach(f=>{try{f(snap(path.split("/")[1],docs.get(path)??null,fromCache))}catch(e){}});
    (collL.get(coll)||[]).forEach(f=>{try{f(qsnap(coll,fromCache))}catch(e){}});
  });
}
function notifyAll(fromCache){
  for(const p of docL.keys())notify(p,fromCache);
  for(const c of collL.keys())queueMicrotask(()=>(collL.get(c)||[]).forEach(f=>{try{f(qsnap(c,fromCache))}catch(e){}}));
}
let loaded=false;
async function loadAll(){
  await ready; await findHid();
  const r=await sb.from("recipe_docs").select("coll,id,data").eq("household_id",C.hid);
  if(r.error)throw r.error;
  docs.clear(); for(const row of r.data||[])docs.set(row.coll+"/"+row.id,row.data);
  loaded=true; saveCache(); notifyAll(false); subscribe();
}
let chan=null;
function subscribe(){
  if(chan||!C.hid)return;
  try{
    chan=sb.channel("recipes-"+C.hid).on("postgres_changes",{event:"*",schema:"public",table:"recipe_docs",filter:"household_id=eq."+C.hid},p=>{
      const row=p.eventType==="DELETE"?p.old:p.new; if(!row||!row.coll)return loadAll().catch(()=>{});
      const path=row.coll+"/"+row.id;
      if(p.eventType==="DELETE")docs.delete(path);else docs.set(path,row.data);
      saveCache(); notify(path,false);
    }).subscribe();
  }catch(e){chan=null}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&uid)loadAll().catch(()=>{})});
const boot=ready.then(id=>id?loadAll():null).catch(()=>{});

const split=path=>{const s=String(path).split("/");if(s.length!==2||!s[0]||!s[1])throw new TypeError("unsupported path "+path);return s};
function docRef(path){
  const [coll,id]=split(path);
  const write=async data=>{
    await ready; await findHid();
    const before=docs.get(path);
    docs.set(path,clone(data)); saveCache(); notify(path,false);
    const r=await sb.from("recipe_docs").upsert({household_id:C.hid,coll,id,data,updated_at:new Date().toISOString()});
    if(r.error){if(before===undefined)docs.delete(path);else docs.set(path,before);saveCache();notify(path,false);throw fail(r.error,"invalid_argument")}
  };
  return {id,path,
    get:async()=>{await boot;return snap(id,docs.get(path)??null,!loaded)},
    set:write,
    update:async part=>{await boot;const cur=docs.get(path);if(cur==null)throw fail("missing","invalid_argument");await write(merge(cur,part))},
    delete:async()=>{await ready;await findHid();const before=docs.get(path);docs.delete(path);saveCache();notify(path,false);
      const r=await sb.from("recipe_docs").delete().eq("household_id",C.hid).eq("coll",coll).eq("id",id);
      if(r.error){if(before!==undefined)docs.set(path,before);saveCache();notify(path,false);throw fail(r.error,"invalid_argument")}},
    onSnapshot:(next)=>{if(!docL.has(path))docL.set(path,new Set());docL.get(path).add(next);
      if(docs.has(path)||loaded)queueMicrotask(()=>next(snap(id,docs.get(path)??null,!loaded)));
      return()=>docL.get(path)&&docL.get(path).delete(next)},
    collection:()=>{throw new TypeError("nested collections aren't used here")}};
}
const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
function collRef(coll){
  if(String(coll).includes("/"))throw new TypeError("unsupported collection "+coll);
  return {path:coll,
    doc:id=>docRef(coll+"/"+(id||newId())),
    add:async data=>{const d=docRef(coll+"/"+newId());await d.set(data);return d},
    get:async()=>{await boot;return qsnap(coll,!loaded)},
    where(){return this},orderBy(){return this},limit(){return this},
    onSnapshot:(next)=>{if(!collL.has(coll))collL.set(coll,new Set());collL.get(coll).add(next);
      if(docs.size||loaded)queueMicrotask(()=>next(qsnap(coll,!loaded)));
      return()=>collL.get(coll)&&collL.get(coll).delete(next)}};
}
const db={doc:docRef,collection:collRef};

/* ---------- recipe import from a link, through the free "recipe-import" Supabase function ---------- */
C.importUrl=async url=>{
  const r=await sb.functions.invoke("recipe-import",{body:{url}});
  if(r.error){const x=r.error.context,st=x&&x.status;let m=r.error.message;try{const b=await x.json();if(b&&b.error)m=b.error}catch(e){}
    if(st===404||r.error.name==="FunctionsFetchError")m="Link importing isn't set up in Supabase yet.";throw new Error(m)}
  if(!r.data||!r.data.recipe)throw new Error("Couldn't find a recipe on that page.");
  return r.data.recipe;
};

/* ---------- deals: run the weekly flyer check now, through the free "recipe-deals" function ---------- */
C.checkDeals=async()=>{const r=await sb.functions.invoke("recipe-deals",{body:{}});
  if(r.error){const x=r.error.context,st=x&&x.status;let m=r.error.message;try{const b=await x.json();if(b&&b.error)m=b.error}catch(e){}
    if(st===404||r.error.name==="FunctionsFetchError")m="The deals check isn't set up in Supabase yet.";throw new Error(m)}
  await loadAll().catch(()=>{}); return r.data};

window.claude={use:async n=>{const id=await ready;if(!id)return null;
  if(n==="db"){try{await findHid()}catch(e){return null}return db}
  return null}};
})();
