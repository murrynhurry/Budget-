/* Murry & Matty cloud sync (Supabase).
   Same accounts and shared space as the budget app and Recipe Box. Documents live in the
   recipe_docs table under collections starting with "mm_", so no extra setup is needed.
   Presents the same small storage interface the Claude version uses. */
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
  try{Object.keys(localStorage).filter(k=>k.indexOf("mm-cache")===0).forEach(k=>localStorage.removeItem(k))}catch(e){}};
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
const CACHE="mm-cache-docs";const PFX="mm_";
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
  const r=await sb.from("recipe_docs").select("coll,id,data").eq("household_id",C.hid).like("coll",PFX+"%");
  if(r.error)throw r.error;
  docs.clear(); for(const row of r.data||[])docs.set(row.coll.slice(PFX.length)+"/"+row.id,row.data);
  loaded=true; saveCache(); notifyAll(false); subscribe();
}
let chan=null;
function subscribe(){
  if(chan||!C.hid)return;
  try{
    chan=sb.channel("mm-"+C.hid).on("postgres_changes",{event:"*",schema:"public",table:"recipe_docs",filter:"household_id=eq."+C.hid},p=>{
      const row=p.eventType==="DELETE"?p.old:p.new; if(!row||!row.coll)return loadAll().catch(()=>{});
      if(row.coll.indexOf(PFX)!==0)return;
      const path=row.coll.slice(PFX.length)+"/"+row.id;
      if(p.eventType==="DELETE")docs.delete(path);else docs.set(path,row.data);
      saveCache(); notify(path,false);
    }).subscribe();
  }catch(e){chan=null}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&uid)loadAll().catch(()=>{})});
const boot=ready.then(id=>id?loadAll():null).catch(()=>{});

const split=path=>{const u=String(path).match(/^data\/users\/([^/]+)\/prefs$/);if(u)return ["prefs",u[1]];const s=String(path).split("/");if(s.length!==2||!s[0]||!s[1])throw new TypeError("unsupported path "+path);return s};
function docRef(path){
  const [coll,id]=split(path);path=coll+"/"+id;
  const write=async data=>{
    await ready; await findHid();
    const before=docs.get(path);
    docs.set(path,clone(data)); saveCache(); notify(path,false);
    const r=await sb.from("recipe_docs").upsert({household_id:C.hid,coll:PFX+coll,id,data,updated_at:new Date().toISOString()});
    if(r.error){if(before===undefined)docs.delete(path);else docs.set(path,before);saveCache();notify(path,false);throw fail(r.error,"invalid_argument")}
  };
  return {id,path,
    get:async()=>{await boot;return snap(id,docs.get(path)??null,!loaded)},
    set:write,
    update:async part=>{await boot;const cur=docs.get(path);if(cur==null)throw fail("missing","invalid_argument");await write(merge(cur,part))},
    delete:async()=>{await ready;await findHid();const before=docs.get(path);docs.delete(path);saveCache();notify(path,false);
      const r=await sb.from("recipe_docs").delete().eq("household_id",C.hid).eq("coll",PFX+coll).eq("id",id);
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

/* ---------- people: names come from the shared space (set in Settings here or in the budget app) ---------- */
async function spaceData(){await findHid();const r=await sb.from("households").select("data").eq("id",C.hid).maybeSingle();return (r.data&&r.data.data)||{}}
const user={id:async()=>{await ready;return uid},can:async()=>true,
  profiles:async ids=>{const d=await spaceData().catch(()=>({})),m=d.members||{},out={};
    for(const id of ids){const n=(m[id]&&m[id].name)||(id===uid&&C.email?C.email.split("@")[0]:"");out[id]={name:n}}return out}};
C.myName=async()=>{const d=await spaceData();return ((d.members||{})[uid]||{}).name||""};
C.setName=async name=>{const d=await spaceData();d.members=d.members||{};d.members[uid]=Object.assign({},d.members[uid],{name:String(name).slice(0,40),joined:true});
  const r=await sb.from("households").update({data:d}).eq("id",C.hid);if(r.error)throw r.error};

/* ---------- ideas: a built-in idea box stands in for "ask Claude" in the phone app ---------- */
const DATES=[
 ["Candlelit fondue night","Melt cheese or chocolate, cut up bread, fruit and veggies, and eat slowly by candlelight.","$","home","cozy low"],
 ["Blanket fort movie marathon","Build a fort, pick a theme (comfort movies, a trilogy), make popcorn with toppings.","$","home","cozy low"],
 ["Cook a new cuisine together","Pick a country neither of you has cooked from, shop for it together and cook as a team.","$$","home","cozy new"],
 ["At-home spa night","Face masks, a warm bath or foot soak, and give each other a massage with a calm playlist.","$","home","cozy low"],
 ["Puzzle and tea night","Start a 500-piece puzzle with a pot of tea and a snack board; leave it out to finish later.","$","home","cozy low"],
 ["Paint each other's portraits","Cheap canvases or paper, 30 minutes each, then a big reveal. Hang the best one.","$","home","cozy new"],
 ["Homemade pizza contest","Make dough together, each build a pizza for the other, and judge with a silly scorecard.","$","home","cozy low"],
 ["Board game tournament","Best of three across different games, loser makes dessert.","$","home","cozy low"],
 ["Write letters to future us","Write letters to open on your next anniversary and seal them with the date.","$","home","cozy low"],
 ["Stargazing drive","Drive out past the city lights with blankets and hot chocolate; use a free star app to find planets.","$","out","outdoors low"],
 ["Sunset walk and food truck","Walk a trail or river path at sunset, then grab something from a food truck or stand.","$","out","outdoors low"],
 ["Night picnic in the park","Pack a thermos, snacks and fairy lights and find a quiet bench or blanket spot.","$","out","outdoors low"],
 ["Fall leaves and cider","Walk somewhere with big trees, collect the prettiest leaves, warm up with hot cider after.","$","out","outdoors low"],
 ["Skating or a winter walk","Find an outdoor rink or a lit-up path, then warm up with something hot.","$","out","outdoors low"],
 ["Try a dessert crawl","Visit two or three spots for one dessert each and rank them.","$$","out","out new"],
 ["Live music night","Find a small local show or open mic and sit near the front.","$$","out","out new"],
 ["Comedy club","Check for a stand-up or improv night, then talk about your favourite jokes over a drink.","$$","out","out new"],
 ["Bowling or mini golf","A little friendly competition; loser buys the snacks.","$$","out","out low"],
 ["Arcade date","Pool your tokens, aim for the silliest prize at the counter.","$$","out","out new"],
 ["Dress-up dinner","Dress fancier than needed for a nice dinner somewhere you've both wanted to try.","$$$","out","out"],
 ["Pottery or paint class","Book a beginner class and make something together for your place.","$$$","out","new out"],
 ["Library and cozy café","Each pick a book for the other at the library, then read together in a café.","$","out","low cozy new"],
 ["Museum late night","Many museums have evening hours; pick the weirdest exhibit and make up stories.","$$","out","new out"],
 ["Grocery store challenge","$15 each to buy ingredients for a surprise snack for the other, then taste-test at home.","$","home","low new"],
 ["Learn a dance from a video","Pick a short dance tutorial and learn it together; film the final take.","$","home","new low cozy"],
 ["Photo walk","Walk a neighbourhood and each take 10 photos on a theme, then compare.","$","out","outdoors low new"],
 ["Karaoke in the living room","Lyrics videos on the TV, a hairbrush mic, and a duet to finish.","$","home","cozy low"],
 ["Plan a dream trip","Pick a place, research it together with snacks, and make a pretend itinerary.","$","home","cozy low"]];
const HOBBIES=[
 ["Pottery","Hand-building or wheel classes; you get to keep what you make.","out"],["Bouldering","Beginner-friendly climbing; easy to rent shoes at a gym.","out"],
 ["Cooking club for two","Cook one new recipe from a cookbook each week.","home"],["Jigsaw puzzles","A big puzzle on the table to chip away at most evenings.","home"],
 ["Book club for two","Read the same book and talk about a few chapters each week.","home"],["Learning a language","Practise together for 15 minutes a day and label things around the house.","home"],
 ["Hiking","Start with short local trails and build up to a bigger hike.","out"],["Baking bread","Sourdough or simple loaves; great for slow weekends.","home"],
 ["Board game collection","Try a new two-player game each month.","home"],["Gardening","Herbs on the balcony or a few pots of easy plants.","home"],
 ["Photography","Weekly photo walks with a theme.","out"],["Dancing lessons","Salsa, swing or a drop-in class.","out"],
 ["Yoga together","Follow a free video a few mornings a week.","home"],["Watercolour painting","Cheap starter kit and simple tutorials.","home"],
 ["Volunteering","An animal shelter or food bank shift once a month.","out"],["Thrift flipping","Find furniture or clothes and fix them up together.","out"],
 ["Biking","Explore bike paths on weekends.","out"],["Skating","Indoor or outdoor rinks; learn a few tricks.","out"],
 ["Candle making","Simple soy candles with scents you choose.","home"],["Building LEGO sets","A big set to finish together over a few nights.","home"],
 ["Running together","A beginner 5 km plan to finish side by side.","out"],["Crossword or sudoku","A daily puzzle with your morning coffee.","home"],
 ["Fishing","A quiet morning at a lake; borrow gear to start.","out"],["Birdwatching","A cheap guide and binoculars on walks.","out"]];
const pick=(arr,n)=>arr.map(x=>[Math.random(),x]).sort((a,b)=>a[0]-b[0]).slice(0,n).map(x=>x[1]);
const sample={json:async prompt=>{
  const p=String(prompt);
  if(/hobbies/i.test(p)){
    const have=(p.match(/suggest different ones: (.*?)\. /)||[,""])[1].toLowerCase();
    const pool=HOBBIES.filter(h=>!have.includes(h[0].toLowerCase()));
    return pick(pool.length>=4?pool:HOBBIES,4).map(([title,note,where])=>({title,note,where}));
  }
  const mood=((p.match(/Mood: ([^.]*)\./)||[,"Anything"])[1]).toLowerCase();
  const key=mood.includes("cozy")?"cozy":mood.includes("town")?"out":mood.includes("outdoor")?"outdoors":mood.includes("budget")?"low":mood.includes("new")?"new":"";
  let pool=key?DATES.filter(d=>d[4].split(" ").includes(key)):DATES;if(pool.length<4)pool=DATES;
  let out=pick(pool,4);if(!key&&!out.some(d=>d[3]==="home"))out[3]=pick(DATES.filter(d=>d[3]==="home"),1)[0];
  return out.map(([title,detail,cost,where])=>({title,detail,cost,where}));
}};

window.claude={use:async n=>{const id=await ready;if(!id)return null;
  if(n==="db"){try{await findHid()}catch(e){return null}return db}
  if(n==="user")return user;
  if(n==="sample")return sample;
  return null}};
})();
