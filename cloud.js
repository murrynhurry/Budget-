/* Budget Tracker cloud sync (Supabase).
   Presents the same small storage interface the app already uses, so the
   shared/private logic is identical to the Claude version. */
(function(){
"use strict";
const CFG={url:"https://crrkwfolrkaruoolfyqm.supabase.co",key:"sb_publishable_6bIJ88uhx2IkXAj9Gbc_8g_5GByxg19"};
window.CLOUD=null; window.CLOUD_READY=false;
if(!window.supabase||!CFG.url||CFG.url.indexOf("__")===0)return;

const sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const ref=new URL(CFG.url).hostname.split(".")[0];
let hasSession=false; try{hasSession=!!localStorage.getItem("sb-"+ref+"-auth-token")}catch(e){}
const C=window.CLOUD={sb,signedIn:hasSession,email:null,hid:null,invite:null,ready:Promise.resolve(null)};

C.signIn=async(email,pw)=>{const r=await sb.auth.signInWithPassword({email,password:pw});if(r.error)throw r.error;return r.data};
C.signUp=async(email,pw)=>{const r=await sb.auth.signUp({email,password:pw});if(r.error)throw r.error;
  if(!r.data||!r.data.session)throw new Error("Account made. Check your email to confirm it, then sign in.");return r.data};
C.signOut=async()=>{try{await sb.auth.signOut()}catch(e){}
  try{Object.keys(localStorage).filter(k=>k.indexOf("cloud-cache-")===0).forEach(k=>localStorage.removeItem(k))}catch(e){}};
C.join=async code=>{const r=await sb.rpc("join_household",{code:String(code||"").trim()});if(r.error)throw r.error;return r.data};

if(!hasSession)return;
window.CLOUD_READY=true;

let uid=null;
const ready=C.ready=sb.auth.getSession().then(({data})=>{const s=data&&data.session;if(!s)return null;uid=s.user.id;C.email=s.user.email;return uid}).catch(()=>null);

const cacheKey=k=>"cloud-cache-"+k;
const cget=k=>{try{return JSON.parse(localStorage.getItem(cacheKey(k)))}catch(e){return null}};
const cset=(k,v)=>{try{localStorage.setItem(cacheKey(k),JSON.stringify(v))}catch(e){}};
const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
const snap=(id,data)=>({id,exists:data!=null,data:()=>data==null?undefined:clone(data),metadata:{fromCache:false,hasPendingWrites:false}});
const isObj=x=>x&&typeof x==="object"&&!Array.isArray(x);
const merge=(a,b)=>{const o=Object.assign({},a||{});for(const k in b){o[k]=isObj(b[k])&&isObj(o[k])?merge(o[k],b[k]):b[k]}return o};
const fail=(e,code)=>{const err={code:code||"unavailable",message:String((e&&e.message)||e)};return err};

async function findHid(){
  if(C.hid)return C.hid;
  const r=await sb.from("household_members").select("household_id,joined_at").eq("user_id",uid).order("joined_at",{ascending:false}).limit(1);
  if(r.error)throw r.error;
  C.hid=r.data&&r.data[0]?r.data[0].household_id:null;
  if(C.hid)subscribe();
  return C.hid;
}
async function loadHousehold(){
  await findHid(); if(!C.hid)return null;
  const r=await sb.from("households").select("data,invite_code").eq("id",C.hid).maybeSingle();
  if(r.error)throw r.error; if(!r.data)return null;
  C.invite=r.data.invite_code; cset("meta",r.data.data); cset("invite",C.invite);
  return r.data.data;
}

const L={budget:[],meta:[],stx:[],sset:[],sbill:[]};
async function fireBudget(){const r=await sb.from("budgets").select("data").eq("user_id",uid).maybeSingle();if(r.error)return;const d=r.data?r.data.data:null;if(d)cset("budget",d);L.budget.forEach(f=>f(snap("budget",d)))}
async function fireMeta(){try{const d=await loadHousehold();L.meta.forEach(f=>f(snap("meta",d)))}catch(e){const c=cget("meta");if(c)L.meta.forEach(f=>f(snap("meta",c)))}}
function qsnap(rows){const docs=(rows||[]).map(x=>snap(x.id,x.data));return {docs,size:docs.length,empty:!docs.length,docChanges:()=>[],metadata:{fromCache:false,hasPendingWrites:false}}}
async function fireKind(k){
  try{await findHid()}catch(e){}
  if(!C.hid){const c=cget(k);if(c)L[k].forEach(f=>f(qsnap(c)));return}
  const r=await sb.from("shared_items").select("id,data").eq("household_id",C.hid).eq("kind",k);
  if(r.error){const c=cget(k);if(c)L[k].forEach(f=>f(qsnap(c)));return}
  cset(k,r.data); L[k].forEach(f=>f(qsnap(r.data)));
}
function fireAll(){fireBudget();fireMeta();["stx","sset","sbill"].forEach(fireKind)}

let chan=null;
function subscribe(){
  if(chan||!uid)return;
  try{
    chan=sb.channel("budget-sync-"+uid)
      .on("postgres_changes",{event:"*",schema:"public",table:"budgets",filter:"user_id=eq."+uid},()=>fireBudget())
      .on("postgres_changes",{event:"*",schema:"public",table:"households"},()=>fireMeta())
      .on("postgres_changes",{event:"*",schema:"public",table:"shared_items"},p=>{const k=(p.new&&p.new.kind)||(p.old&&p.old.kind);if(k&&L[k])fireKind(k);else["stx","sset","sbill"].forEach(fireKind)})
      .subscribe();
  }catch(e){chan=null}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&uid)fireAll()});
setInterval(()=>{if(uid&&document.visibilityState==="visible")["stx","sset","sbill"].forEach(fireKind)},60000);

function metaRef(){return {path:"hh/meta",id:"meta",
  get:async()=>{await ready;try{return snap("meta",await loadHousehold())}catch(e){const c=cget("meta");if(c){C.invite=cget("invite");return snap("meta",c)}throw fail(e)}},
  set:async data=>{await ready;await findHid();
    if(!C.hid){
      const r=await sb.from("households").insert({data,created_by:uid}).select("id,invite_code").single(); if(r.error)throw fail(r.error,"invalid_argument");
      C.hid=r.data.id; C.invite=r.data.invite_code;
      const m=await sb.from("household_members").insert({household_id:C.hid,user_id:uid}); if(m.error)throw fail(m.error,"invalid_argument");
      subscribe();
    }else{const r=await sb.from("households").update({data}).eq("id",C.hid);if(r.error)throw fail(r.error,"invalid_argument")}
    cset("meta",data);},
  update:async part=>{await ready;const cur=await loadHousehold();if(cur==null)throw fail("missing","invalid_argument");
    const next=merge(cur,part);const r=await sb.from("households").update({data:next}).eq("id",C.hid);if(r.error)throw fail(r.error,"invalid_argument");cset("meta",next);},
  delete:async()=>{},
  onSnapshot:(next)=>{L.meta.push(next);ready.then(fireMeta);return()=>{const i=L.meta.indexOf(next);if(i>=0)L.meta.splice(i,1)}}}}

function budgetRef(){return {path:"budget",id:"budget",
  get:async()=>{await ready;const r=await sb.from("budgets").select("data").eq("user_id",uid).maybeSingle();
    if(r.error){const c=cget("budget");if(c)return snap("budget",c);throw fail(r.error)}
    const d=r.data?r.data.data:null;if(d)cset("budget",d);return snap("budget",d)},
  set:async data=>{await ready;cset("budget",data);const r=await sb.from("budgets").upsert({user_id:uid,data,updated_at:new Date().toISOString()});if(r.error)throw fail(r.error)},
  update:async part=>{await ready;const cur=(await budgetRef().get()).data();if(!cur)throw fail("missing","invalid_argument");await budgetRef().set(merge(cur,part))},
  delete:async()=>{await ready;await sb.from("budgets").delete().eq("user_id",uid)},
  onSnapshot:(next)=>{L.budget.push(next);subscribe();return()=>{const i=L.budget.indexOf(next);if(i>=0)L.budget.splice(i,1)}}}}

function itemRef(kind,id){const self={id,path:kind+"/"+id,
  get:async()=>{await ready;await findHid();const r=await sb.from("shared_items").select("data").eq("household_id",C.hid).eq("kind",kind).eq("id",id).maybeSingle();if(r.error)throw fail(r.error);return snap(id,r.data?r.data.data:null)},
  set:async data=>{await ready;await findHid();if(!C.hid)throw fail("no shared space","invalid_argument");
    const r=await sb.from("shared_items").upsert({household_id:C.hid,kind,id,data,updated_at:new Date().toISOString()});if(r.error)throw fail(r.error,"invalid_argument");fireKind(kind)},
  update:async part=>{const cur=(await self.get()).data();if(!cur)throw fail("missing","invalid_argument");await self.set(merge(cur,part))},
  delete:async()=>{await ready;await findHid();const r=await sb.from("shared_items").delete().eq("household_id",C.hid).eq("kind",kind).eq("id",id);if(r.error)throw fail(r.error,"invalid_argument");fireKind(kind)},
  onSnapshot:()=>()=>{}};return self}
function collRef(kind){if(!L[kind])throw new TypeError("unsupported collection "+kind);return {path:kind,
  doc:id=>itemRef(kind,id||Math.random().toString(36).slice(2,10)),
  onSnapshot:(next)=>{L[kind].push(next);ready.then(()=>fireKind(kind));return()=>{const i=L[kind].indexOf(next);if(i>=0)L[kind].splice(i,1)}}}}

const db={doc:p=>{if(p==="hh/meta")return metaRef();if(/^data\/users\/[^/]+\/budget$/.test(p))return budgetRef();throw new TypeError("unsupported path "+p)},collection:collRef};
const user={id:async()=>{await ready;return uid}};
window.claude={use:async n=>{const id=await ready;if(!id)return null;if(n==="db")return db;if(n==="user")return user;return null}};
})();
