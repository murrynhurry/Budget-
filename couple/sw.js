// Keeps Murry & Matty working offline. Bump VERSION to push an update.
const VERSION="couple-v48";
const CORE=["./","index.html","cloud.js","manifest.webmanifest","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("couple-")&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET")return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    e.respondWith(fetch(req,{cache:"no-cache"}).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res}).catch(()=>caches.match(req).then(r=>r||caches.match("index.html"))));
  }else if(url.hostname.endsWith("gstatic.com")||url.hostname.endsWith("googleapis.com")||url.hostname==="cdn.jsdelivr.net"){
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res})));
  }
});
self.addEventListener("push",e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data&&e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"Murry & Matty",{body:d.body||"",tag:d.tag||undefined,icon:"icons/icon-192.png",badge:"icons/icon-192.png",data:{url:d.url||"./"}}));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();const url=new URL((e.notification.data&&e.notification.data.url)||"./",self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{for(const w of ws){if("focus" in w){w.navigate&&w.navigate(url).catch(()=>{});return w.focus()}}return clients.openWindow(url)}));
});
