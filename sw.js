// Keeps the app working offline. Bump VERSION to push an update.
const VERSION="budget-v41";
const CORE=["./","index.html","cloud.js","manifest.webmanifest","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET")return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // app files: try the network first so updates show up, fall back to the saved copy offline
    e.respondWith(fetch(req,{cache:"no-cache"}).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res}).catch(()=>caches.match(req).then(r=>r||caches.match("index.html"))));
  }else if(url.hostname.endsWith("gstatic.com")||url.hostname.endsWith("googleapis.com")||url.hostname==="cdn.jsdelivr.net"){
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res})));
  }
});
