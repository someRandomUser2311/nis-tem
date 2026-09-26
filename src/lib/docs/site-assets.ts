// Stylesheet and script of the published docs site (lib/docs/site.ts). Self-contained: no
// fonts, libraries or requests from the network, so the site works from file://, an intranet
// server or GitHub Pages alike.

export const SITE_CSS = `
:root{--bg:#ffffff;--bg2:#f6f7f9;--bg3:#eceef2;--fg:#1c1e21;--fg2:#4b5058;--fg3:#7a808a;--line:#e3e6ea;--accent:#ff6c37;--ok:#12805c;--warn:#b25e00;--err:#c9302c;--info:#1f6feb;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
--get:#12805c;--post:#b25e00;--put:#1f6feb;--patch:#7b3fbf;--delete:#c9302c;--other:#5b616b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121416;--bg2:#1a1d20;--bg3:#24282c;--fg:#e8eaed;--fg2:#b3b8bf;--fg3:#868c95;--line:#2c3136;--ok:#3fbf8a;--warn:#e0a03a;--err:#f06b66;--info:#58a6ff;
--get:#3fbf8a;--post:#e0a03a;--put:#58a6ff;--patch:#b58cf0;--delete:#f06b66;--other:#9aa0a8}}
:root[data-theme=dark]{--bg:#121416;--bg2:#1a1d20;--bg3:#24282c;--fg:#e8eaed;--fg2:#b3b8bf;--fg3:#868c95;--line:#2c3136;--ok:#3fbf8a;--warn:#e0a03a;--err:#f06b66;--info:#58a6ff;
--get:#3fbf8a;--post:#e0a03a;--put:#58a6ff;--patch:#b58cf0;--delete:#f06b66;--other:#9aa0a8}
*{box-sizing:border-box}html{scroll-padding-top:70px}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--info)}code,pre{font-family:var(--mono)}
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:56px;padding:0 20px;background:var(--bg);border-bottom:1px solid var(--line)}
.top img{height:28px;width:auto;border-radius:6px}.top .title{font-weight:700;font-size:16px}.top .spacer{flex:1}
.badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--bg3);color:var(--fg2)}
.top select,.top button{font:inherit;font-size:13px;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:6px;height:32px;padding:0 10px;cursor:pointer}
#menu{display:none}
.layout{display:flex;min-height:calc(100vh - 56px)}
.side{width:270px;flex-shrink:0;border-right:1px solid var(--line);position:sticky;top:56px;height:calc(100vh - 56px);overflow:auto;padding:14px 10px 30px}
.side input{width:100%;font:inherit;font-size:13px;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:6px;height:34px;padding:0 10px;margin-bottom:10px;outline:none}
.side input:focus{border-color:var(--accent)}
.toc,.results{list-style:none;margin:0;padding:0}
.toc a,.results a{display:flex;gap:8px;align-items:baseline;padding:4px 10px;border-radius:6px;color:var(--fg2);text-decoration:none;font-size:13px;line-height:1.4}
.toc a:hover,.results a:hover{background:var(--bg3);color:var(--fg)}
.toc a.active{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--fg)}
.toc .group{margin:14px 10px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--fg3)}
.toc a.folder{font-weight:600;color:var(--fg)}
.m{font-family:var(--mono);font-size:10.5px;font-weight:700;min-width:44px;flex-shrink:0}
.m-get{color:var(--get)}.m-post{color:var(--post)}.m-put{color:var(--put)}.m-patch{color:var(--patch)}.m-delete{color:var(--delete)}.m-other,.m-head,.m-options,.m-ws,.m-sse{color:var(--other)}
.results .hint{color:var(--fg3);font-size:12px;padding:4px 10px}
main{flex:1;min-width:0;padding:28px 36px 80px}
.doc,.folder-doc{max-width:880px;margin-bottom:34px}
h1{font-size:30px;margin:0 0 14px;line-height:1.2}h2{font-size:22px;margin:0 0 12px}h3{font-size:18px;margin:0}
.folder-doc{padding-top:18px;border-top:1px solid var(--line)}
.crumbs{color:var(--fg3);font-weight:400}
.md :first-child{margin-top:0}.md pre{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto;font-size:12.5px}
.md code{font-size:.92em;background:var(--bg3);padding:1px 5px;border-radius:4px}.md pre code{background:none;padding:0}
.md table{border-collapse:collapse}.md th,.md td{border:1px solid var(--line);padding:5px 10px}
.md blockquote{margin:0;padding-left:14px;border-left:3px solid var(--line);color:var(--fg2)}
.md img{max-width:100%}
.callout{border-left:3px solid var(--info);background:color-mix(in srgb,var(--info) 9%,transparent);border-radius:0 8px 8px 0;padding:8px 14px;margin:12px 0}
.callout-title{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--info)}
.callout-tip{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 9%,transparent)}.callout-tip .callout-title{color:var(--ok)}
.callout-important{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,transparent)}.callout-important .callout-title{color:var(--accent)}
.callout-warning{border-color:var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent)}.callout-warning .callout-title{color:var(--warn)}
.callout-caution{border-color:var(--err);background:color-mix(in srgb,var(--err) 9%,transparent)}.callout-caution .callout-title{color:var(--err)}
.req-link{text-decoration:underline dotted}.req-link.broken{color:var(--err);text-decoration:line-through}
pre.mermaid{background:none;border:none;text-align:center}
.auth{display:inline-flex;gap:6px;align-items:center;margin:10px 0 4px;padding:5px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg2);font-size:13px;color:var(--fg2)}
.ep{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,42%);gap:28px;padding:26px 0 30px;border-top:1px solid var(--line)}
.ep-main{min-width:0}.ep-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{font-family:var(--mono);font-size:11px;font-weight:700;border:1px solid currentColor;border-radius:5px;padding:1px 7px}
.status-beta{color:var(--info);background:color-mix(in srgb,var(--info) 14%,transparent)}.status-deprecated{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.ep.deprecated h3{text-decoration:line-through;color:var(--fg2)}
.tag{font-size:11.5px;padding:1px 9px;border-radius:999px;border:1px solid var(--line);color:var(--fg2)}
.url{margin:10px 0 12px;padding:8px 12px;background:var(--bg2);border:1px solid var(--line);border-radius:8px;font-family:var(--mono);font-size:13px;word-break:break-all}
h4{margin:18px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--fg2)}
table.fields{width:100%;border-collapse:collapse;font-size:13px}
table.fields th{text-align:left;font-size:11.5px;color:var(--fg3);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
table.fields td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.fields td:first-child{white-space:nowrap;width:1%}
.req{color:var(--err);font-weight:700;margin-left:2px}.type{font-family:var(--mono);font-size:12px;color:var(--fg2);white-space:nowrap}
.sub{font-size:12px;color:var(--fg3);margin-top:2px}.sub code{background:var(--bg3);padding:0 4px;border-radius:3px;color:var(--fg2)}
tr.dep td:first-child code{text-decoration:line-through}
.variant{font-size:10px;font-weight:700;background:var(--bg3);border-radius:3px;padding:0 5px;margin-right:4px}
pre.code{margin:6px 0;padding:12px 14px;background:var(--bg2);border:1px solid var(--line);border-radius:8px;font-size:12.5px;line-height:1.5;overflow:auto;max-height:460px}
details.example{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:0 12px}
details.example summary{cursor:pointer;padding:8px 0;font-size:13px}details.example summary b{font-family:var(--mono);margin-right:6px}
.ep-side{min-width:0}.samples{position:sticky;top:72px}
.sample{display:none}body[data-lang] .sample.on{display:block}
.sample-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--fg3)}
.copy{font:inherit;font-size:12px;color:var(--fg2);background:none;border:1px solid var(--line);border-radius:5px;padding:1px 8px;cursor:pointer}
footer{margin-top:40px;color:var(--fg3);font-size:12px}
@media (max-width:1100px){.ep{grid-template-columns:minmax(0,1fr)}.samples{position:static}}
@media (max-width:760px){#menu{display:inline-block}.side{position:fixed;left:0;top:56px;z-index:9;background:var(--bg);transform:translateX(-100%);transition:transform .15s}
body.nav-open .side{transform:none;box-shadow:0 10px 30px rgba(0,0,0,.25)}main{padding:20px 16px 60px}.top{padding:0 12px}.top .title{font-size:14px}}
@media print{.top,.side,.copy{display:none!important}main{padding:0}.ep{display:block;break-inside:avoid-page}.samples{position:static}
.sample{display:none!important}.sample.on{display:block!important}pre.code{max-height:none;white-space:pre-wrap}details.example{break-inside:avoid}}
`;

export const SITE_JS = `
(function(){
var root=document.documentElement,body=document.body;
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
// theme
var t=store("lp-docs-theme");if(t)root.dataset.theme=t;
var tb=document.getElementById("theme");if(tb)tb.onclick=function(){var dark=root.dataset.theme?root.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;root.dataset.theme=dark?"light":"dark";store("lp-docs-theme",root.dataset.theme);renderMermaid(true)};
// code sample language
var sel=document.getElementById("lang");
function setLang(l){body.dataset.lang=l;document.querySelectorAll(".sample").forEach(function(s){s.classList.toggle("on",s.dataset.lang===l)});if(sel)sel.value=l;store("lp-docs-lang",l)}
var saved=store("lp-docs-lang");setLang(saved&&document.querySelector('.sample[data-lang="'+saved+'"]')?saved:(sel?sel.value:""));
if(sel)sel.onchange=function(){setLang(sel.value)};
// copy buttons
document.addEventListener("click",function(e){var b=e.target.closest(".copy");if(!b)return;var pre=b.parentNode.nextElementSibling;
navigator.clipboard&&navigator.clipboard.writeText(pre.textContent).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1200)})});
// mobile nav
var mb=document.getElementById("menu");if(mb)mb.onclick=function(){body.classList.toggle("nav-open")};
document.querySelectorAll(".toc a").forEach(function(a){a.addEventListener("click",function(){body.classList.remove("nav-open")})});
// search
var idx=[];try{idx=JSON.parse(document.getElementById("search-index").textContent)}catch(e){}
var q=document.getElementById("q"),res=document.getElementById("results"),toc=document.querySelector(".toc");
function esc(s){return s.replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
if(q)q.oninput=function(){var s=q.value.trim().toLowerCase();if(!s){res.innerHTML="";toc.style.display="";return}
var terms=s.split(/\\s+/),hits=idx.filter(function(x){var h=(x.t+" "+(x.m||"")+" "+(x.u||"")+" "+x.x).toLowerCase();return terms.every(function(w){return h.indexOf(w)>=0})}).slice(0,40);
toc.style.display="none";res.innerHTML=hits.length?hits.map(function(x){return '<li><a href="#'+x.a+'">'+(x.m?'<span class="m m-'+x.m.toLowerCase()+'">'+esc(x.m)+'</span>':'')+'<span>'+esc(x.t)+'</span></a></li>'}).join(""):'<li class="hint">No matches</li>'};
// scroll spy
var links={};document.querySelectorAll(".toc a").forEach(function(a){links[a.getAttribute("href").slice(1)]=a});
if("IntersectionObserver" in window){var cur;var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){if(cur)cur.classList.remove("active");cur=links[e.target.id];if(cur)cur.classList.add("active")}})},{rootMargin:"-70px 0px -70% 0px"});
document.querySelectorAll("main [id]").forEach(function(s){if(links[s.id])io.observe(s)})}
// diagrams
function renderMermaid(again){if(!window.mermaid||!document.querySelector(".mermaid"))return;
var dark=root.dataset.theme?root.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
document.querySelectorAll(".mermaid").forEach(function(el){if(!el.dataset.src)el.dataset.src=el.textContent;if(again){el.removeAttribute("data-processed");el.textContent=el.dataset.src}});
window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:dark?"dark":"default"});window.mermaid.run({querySelector:".mermaid"})}
renderMermaid(false);
if(body.dataset.autoprint!==undefined)window.addEventListener("load",function(){setTimeout(function(){window.print()},400)});
})();
`;
