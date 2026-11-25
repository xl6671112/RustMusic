document.documentElement.classList.add("js");
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    entry.target.classList.add("visible");
    observer.unobserve(entry.target);
  }
}, {threshold: .08});
document.querySelectorAll(".reveal").forEach(el => observer.observe(el));
const wave = document.querySelector(".wave");
for (let i = 0; i < 40; i++) {
  const bar = document.createElement("i");
  bar.style.height = `${10 + ((i * 17) % 38)}px`;
  bar.style.animationDelay = `${-(i % 9) / 6}s`;
  wave.append(bar);
}
const descriptions = ["原唱模式 · 保留完整音乐表达", "伴奏模式 · 把主唱的位置留给你", "人声模式 · 听清演唱的细节"];
document.querySelectorAll(".demo-tabs button").forEach((button,index,buttons) => {
  button.addEventListener("click", () => {
    buttons.forEach(other => {
      other.classList.toggle("selected", other === button);
      other.setAttribute("aria-pressed", String(other === button));
    });
    document.querySelector("#demo-caption").textContent = descriptions[index];
    wave.style.opacity = index === 2 ? ".55" : "1";
    wave.querySelectorAll("i").forEach((bar,i) => {bar.style.height = `${8 + ((i * (17 + index * 6)) % 42)}px`;});
  });
});
document.addEventListener("visibilitychange", () => {
  document.querySelectorAll(".vinyl,.bars i,.wave i,.ambient i,.ticker div").forEach(el => {
    el.style.animationPlayState = document.hidden ? "paused" : "running";
  });
});
const routeChoice=document.querySelector("#download-route");
const downloadButton=document.querySelector("#download-button");
let downloadConfig;
function updateDownloadChoice() {
  const id=routeChoice.value;
  const item=downloadConfig?.items.find(x=>x.id===(id||downloadConfig.active));
  if(item) {
    downloadButton.href=item.url;
    document.querySelector("#download-info").textContent=item.description||item.name;
  }
}
async function refreshDownloads() {
  try {
    const response=await fetch("/api/downloads",{cache:"no-store"});
    if(!response.ok) return;
    const next=await response.json();
    if(!Array.isArray(next.items)||!next.items.some(x=>x.id===next.active))return;
    downloadConfig=next;
    const selected=routeChoice.value;
    routeChoice.replaceChildren(new Option("当前推荐 · "+next.items.find(x=>x.id===next.active).name,""));
    for(const item of next.items)routeChoice.append(new Option(item.name,item.id));
    routeChoice.value=next.items.some(x=>x.id===selected)?selected:"";
    updateDownloadChoice();
  } catch { /* The default server redirect still resolves the latest selected link. */ }
}
routeChoice.addEventListener("change",updateDownloadChoice);
downloadButton.addEventListener("click",()=>{
  if(!navigator.sendBeacon?.("/api/downloads")) {
    void fetch("/api/downloads",{method:"POST",keepalive:true}).catch(()=>{});
  }
});
void refreshDownloads();
setInterval(()=>{if(!document.hidden)void refreshDownloads();},30000);

const demo=document.querySelector("#player-demo"), demoShell=demo.parentElement;
new ResizeObserver(()=>{const scale=demoShell.clientWidth/1100;demo.style.transform=`scale(${scale})`;demoShell.style.height=`${760*scale}px`;}).observe(demoShell);
