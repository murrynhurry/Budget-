/* Together cloud sync (Supabase).
   Same accounts and shared space as the budget and Recipe Box apps: your partner is
   the other person in your shared space. */
(function(){
"use strict";
const CFG={url:"https://crrkwfolrkaruoolfyqm.supabase.co",key:"sb_publishable_6bIJ88uhx2IkXAj9Gbc_8g_5GByxg19"};
window.CLOUD=null; window.CLOUD_READY=false;
if(!window.supabase)return;

const sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const ref=new URL(CFG.url).hostname.split(".")[0];
let hasSession=false; try{hasSession=!!localStorage.getItem("sb-"+ref+"-auth-token")}catch(e){}
const C=window.CLOUD={sb,signedIn:hasSession,uid:null,email:null,hid:null,invite:null,partnerId:null,crowded:false,
  me:null,partner:null,events:new Map(),onChange:null,ready:Promise.resolve(null)};

C.signIn=async(email,pw)=>{const r=await sb.auth.signInWithPassword({email,password:pw});if(r.error)throw r.error;return r.data};
C.signUp=async(email,pw)=>{const r=await sb.auth.signUp({email,password:pw});if(r.error)throw r.error;
  if(!r.data||!r.data.session)throw new Error("Account made. Check your email to confirm it, then sign in.");return r.data};
C.signOut=async()=>{try{await sb.auth.signOut()}catch(e){}
  try{Object.keys(localStorage).filter(k=>k.indexOf("tg-cache")===0).forEach(k=>localStorage.removeItem(k))}catch(e){}};
C.join=async code=>{const r=await sb.rpc("join_couple",{code:String(code||"").trim()});
  if(r.error){const m=String(r.error.message||"");
    if(/join_couple|function/i.test(m)&&/not find|does not exist/i.test(m))throw new Error("Run couples-setup.sql in Supabase first.");throw r.error}
  return r.data};

if(!hasSession)return;
window.CLOUD_READY=true;

const localTz=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"}catch(e){return "UTC"}};
const CACHE="tg-cache";
function saveCache(){try{localStorage.setItem(CACHE,JSON.stringify({me:C.me,partner:C.partner,partnerId:C.partnerId,invite:C.invite,events:[...C.events.values()]}))}catch(e){}}
try{const c=JSON.parse(localStorage.getItem(CACHE)||"null");if(c){C.me=c.me;C.partner=c.partner;C.partnerId=c.partnerId;C.invite=c.invite;for(const e of c.events||[])C.events.set(e.id,e)}}catch(e){}
const changed=()=>{saveCache();if(typeof C.onChange==="function")try{C.onChange()}catch(e){console.error(e)}};

const ready=C.ready=sb.auth.getSession().then(({data})=>{const s=data&&data.session;if(!s)return null;C.uid=s.user.id;C.email=s.user.email;return C.uid}).catch(()=>null);

/* ---------- shared space: the budget app's household ---------- */
async function findHid(){
  if(C.hid)return C.hid;
  const r=await sb.from("household_members").select("household_id,joined_at").eq("user_id",C.uid).order("joined_at",{ascending:false}).limit(1);
  if(r.error)throw r.error;
  C.hid=r.data&&r.data[0]?r.data[0].household_id:null;
  if(!C.hid){ // first time on any of the apps: make a space, like the budget app does
    const h=await sb.from("households").insert({data:{},created_by:C.uid}).select("id,invite_code").single(); if(h.error)throw h.error;
    const m=await sb.from("household_members").insert({household_id:h.data.id,user_id:C.uid}); if(m.error)throw m.error;
    C.hid=h.data.id; C.invite=h.data.invite_code;
  }
  const h=await sb.from("households").select("invite_code").eq("id",C.hid).maybeSingle();
  if(h.data)C.invite=h.data.invite_code;
  return C.hid;
}
async function findPartner(){
  const r=await sb.from("household_members").select("user_id,joined_at").eq("household_id",C.hid).order("joined_at",{ascending:true});
  if(r.error)throw r.error;
  const others=(r.data||[]).filter(x=>x.user_id!==C.uid);
  C.partnerId=others[0]?others[0].user_id:null; C.crowded=others.length>1;
}

/* ---------- profiles ---------- */
const PROFILE_FIELDS="user_id,display_name,color,day_start,day_end,min_free,timezone";
async function loadProfiles(){
  const ids=[C.uid].concat(C.partnerId?[C.partnerId]:[]);
  const r=await sb.from("couple_profiles").select(PROFILE_FIELDS).in("user_id",ids);
  if(r.error)throw r.error;
  const byId=Object.fromEntries((r.data||[]).map(p=>[p.user_id,p]));
  C.me=byId[C.uid]||null;
  if(!C.me){ // first visit: make a profile with sensible defaults
    const name=(C.email||"").split("@")[0].replace(/[._-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase()).slice(0,40);
    const ins=await sb.from("couple_profiles").upsert({user_id:C.uid,display_name:name,timezone:localTz()}).select(PROFILE_FIELDS).single();
    if(ins.error)throw ins.error; C.me=ins.data;
  }else if(C.me.timezone!==localTz()){ // keep the time zone in step with this phone
    C.saveProfile({timezone:localTz()}).catch(()=>{});
  }
  C.partner=C.partnerId?(byId[C.partnerId]||{user_id:C.partnerId,display_name:"",color:"#5b6ee1",day_start:480,day_end:1320,min_free:60,timezone:C.me.timezone,missing:true}):null;
}
C.saveProfile=async patch=>{
  const next=Object.assign({},C.me,patch,{user_id:C.uid});
  const before=C.me; C.me=next; changed();
  const r=await sb.from("couple_profiles").update(Object.assign({},patch,{updated_at:new Date().toISOString()})).eq("user_id",C.uid).select(PROFILE_FIELDS).single();
  if(r.error){C.me=before;changed();throw r.error}
  C.me=r.data; changed(); return r.data;
};

/* ---------- events ---------- */
const EVENT_FIELDS="id,user_id,title,starts_at,ends_at,all_day";
let loaded=[]; // [from,to] stretches already fetched
const covered=(from,to)=>loaded.some(([a,b])=>a<=from&&b>=to);
C.loadRange=async(from,to)=>{
  await ready; await findHid();
  const r=await sb.from("couple_events").select(EVENT_FIELDS).eq("household_id",C.hid)
    .lt("starts_at",new Date(to).toISOString()).gt("ends_at",new Date(from).toISOString()).order("starts_at");
  if(r.error)throw r.error;
  for(const [id,e] of C.events)if(+new Date(e.starts_at)<to&&+new Date(e.ends_at)>from)C.events.delete(id);
  for(const e of r.data||[])C.events.set(e.id,e);
  loaded.push([from,to]); loaded.sort((a,b)=>a[0]-b[0]);
  loaded=loaded.reduce((o,i)=>{const l=o[o.length-1];if(l&&i[0]<=l[1])l[1]=Math.max(l[1],i[1]);else o.push(i.slice());return o},[]);
  changed();
};
C.ensureRange=(from,to)=>covered(from,to)?Promise.resolve():C.loadRange(from,to);
C.saveEvent=async ev=>{
  await ready; await findHid();
  const row={title:ev.title,starts_at:new Date(ev.starts_at).toISOString(),ends_at:new Date(ev.ends_at).toISOString(),all_day:!!ev.all_day,updated_at:new Date().toISOString()};
  const r=ev.id
    ?await sb.from("couple_events").update(row).eq("id",ev.id).eq("user_id",C.uid).select(EVENT_FIELDS).single()
    :await sb.from("couple_events").insert(Object.assign(row,{household_id:C.hid,user_id:C.uid})).select(EVENT_FIELDS).single();
  if(r.error)throw r.error;
  C.events.set(r.data.id,r.data); changed(); return r.data;
};
C.deleteEvent=async id=>{
  const before=C.events.get(id); C.events.delete(id); changed();
  const r=await sb.from("couple_events").delete().eq("id",id).eq("user_id",C.uid);
  if(r.error){if(before)C.events.set(id,before);changed();throw r.error}
};

/* ---------- live updates ---------- */
let chan=null;
function subscribe(){
  if(chan||!C.hid)return;
  try{
    chan=sb.channel("together-"+C.hid)
      .on("postgres_changes",{event:"*",schema:"public",table:"couple_events",filter:"household_id=eq."+C.hid},p=>{
        if(p.eventType==="DELETE"){if(p.old&&p.old.id)C.events.delete(p.old.id)}else if(p.new)C.events.set(p.new.id,p.new);
        changed();})
      .on("postgres_changes",{event:"*",schema:"public",table:"couple_profiles"},p=>{
        const row=p.new; if(!row)return;
        if(row.user_id===C.uid)C.me=Object.assign({},C.me,row);else if(row.user_id===C.partnerId)C.partner=row;
        changed();})
      .subscribe();
  }catch(e){chan=null}
}

/* Full refresh: space, partner, profiles, and events around the visible range. */
C.refresh=async()=>{
  await ready; if(!C.uid)return;
  await findHid(); await findPartner(); await loadProfiles();
  const now=Date.now(), span=loaded.length?[Math.min(loaded[0][0],now-8*864e5),Math.max(loaded[loaded.length-1][1],now+35*864e5)]:[now-8*864e5,now+35*864e5];
  loaded=[];
  await C.loadRange(span[0],span[1]);
  subscribe();
};
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&C.uid)C.refresh().catch(()=>{})});
})();
