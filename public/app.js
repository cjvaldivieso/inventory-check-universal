/* public/app.js — Shappi Inventory App (v18 stable UX)
   Fixes:
   ✓ No stacked toasts (single clear feedback)
   ✓ Badge shows scan value
   ✓ Remove toast delayed (no collision)
   ✓ Battery saver preserved
*/

const socket = io();

let currentBin   = null;
let scanning     = false;
let activeStream = null;

let lastScan = 0;
const SCAN_COOLDOWN = 900;

const DECODE_INTERVAL_MS = 200;
const DECODE_MAX_WIDTH   = 640;
const CAMERA_FPS_IDEAL   = 15;

const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");
const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");

// --------------------------------------------------
// CAMERA OVERLAY
// --------------------------------------------------
function createOverlay(titleText) {

  const overlay = document.createElement("div");
  overlay.style = `
    position:fixed; inset:0;
    background:rgba(0,0,0,0.92);
    display:flex; flex-direction:column;
    align-items:center; padding-top:40px;
    z-index:9999;
  `;

  const title = document.createElement("div");
  title.textContent = titleText;
  title.style = `color:#fff;font-weight:700;font-size:20px;margin-bottom:14px;`;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.autoplay = true;
  video.muted = true;
  video.style = `width:92vw;max-width:650px;border-radius:14px;`;
  overlay.appendChild(video);

  // Pulse ✓
  const pulse = document.createElement("div");
  pulse.textContent = "✓";
  pulse.style = `
    position:fixed;top:50%;left:50%;
    transform:translate(-50%,-50%);
    width:120px;height:120px;border-radius:999px;
    background:rgba(0,0,0,0.5);
    border:3px solid #28a745;
    color:#28a745;font-size:72px;font-weight:800;
    display:none;align-items:center;justify-content:center;
    z-index:10000;
  `;
  overlay.appendChild(pulse);

  // Badge (scan value)
  const badge = document.createElement("div");
  badge.style = `
    position:fixed;
    bottom:110px;
    left:50%;
    transform:translateX(-50%);
    background:#28a745;
    color:#fff;font-weight:800;font-size:20px;
    padding:12px 18px;border-radius:16px;
    display:none;min-width:220px;text-align:center;
    z-index:10000;
  `;
  overlay.appendChild(badge);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop";
  stopBtn.style = `
    margin-top:18px;background:#ff5555;
    border:none;color:#fff;font-size:18px;
    padding:12px 22px;border-radius:12px;font-weight:600;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, pulse, badge };
}

function stopScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch {}
  activeStream = null;
  scanning = false;
  document.querySelectorAll(".shappi-scan-overlay")?.forEach(o => o.remove());
}

function showPulse(pulse) {
  pulse.style.display = "flex";
  setTimeout(()=> pulse.style.display="none", 650);
}

let badgeTimer;
function showBadge(badge, value) {
  clearTimeout(badgeTimer);
  badge.textContent = `✓ ${value}`;
  badge.style.display = "block";
  badgeTimer = setTimeout(()=> badge.style.display="none", 1000);
}

// --------------------------------------------------
// CAMERA STREAM
// --------------------------------------------------
async function getCameraStream() {
  return navigator.mediaDevices.getUserMedia({
    video:{
      facingMode:"environment",
      frameRate:{ideal:CAMERA_FPS_IDEAL,max:20}
    }
  });
}

function drawFrame(video,canvas,ctx){
  const vw=video.videoWidth,vh=video.videoHeight;
  if(!vw||!vh) return null;
  const scale=Math.min(1,DECODE_MAX_WIDTH/vw);
  canvas.width=vw*scale;
  canvas.height=vh*scale;
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  return ctx.getImageData(0,0,canvas.width,canvas.height);
}

// --------------------------------------------------
// BIN SCAN
// --------------------------------------------------
scanBinBtn.onclick = async () => {
  stopScanner();

  const { overlay, video, stopBtn, pulse, badge } = createOverlay("Scan Bin QR");
  stopBtn.onclick = stopScanner;

  activeStream = await getCameraStream();
  video.srcObject = activeStream;
  await video.play();

  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d");
  let lastDecode=0;

  const loop=async()=>{
    if(!activeStream) return;

    if(Date.now()-lastDecode>DECODE_INTERVAL_MS){
      lastDecode=Date.now();
      const frame=drawFrame(video,canvas,ctx);
      if(frame){
        const code=jsQR(frame.data,frame.width,frame.height);
        if(code?.data){
          const bin=code.data.trim().toUpperCase();
          showPulse(pulse);
          showBadge(badge,bin);

          currentBin=bin;
          currentBinEl.textContent=bin;

          stopScanner();
          startItemScan();
          return;
        }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
};

// --------------------------------------------------
// ITEM SCAN
// --------------------------------------------------
scanItemBtn.onclick = startItemScan;

async function startItemScan() {

  if(!currentBin) return;

  stopScanner();
  scanning=true;

  const { overlay, video, stopBtn, pulse, badge } =
    createOverlay(`Scanning Items • Bin ${currentBin}`);

  stopBtn.onclick = stopScanner;

  activeStream = await getCameraStream();
  video.srcObject = activeStream;
  await video.play();

  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d");
  let lastDecode=0;

  const loop=async()=>{
    if(!scanning) return;

    if(Date.now()-lastDecode>DECODE_INTERVAL_MS){
      lastDecode=Date.now();

      const frame=drawFrame(video,canvas,ctx);
      if(frame){
        const code=jsQR(frame.data,frame.width,frame.height);

        if(code?.data && Date.now()-lastScan>SCAN_COOLDOWN){
          lastScan=Date.now();
          const id=code.data.trim();

          showPulse(pulse);
          showBadge(badge,id);

          await handleItemScan(id);
        }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

// --------------------------------------------------
// HANDLE ITEM RESULT
// --------------------------------------------------
async function handleItemScan(itemId) {

  const res = await fetch("/audit/scan", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({binId:currentBin,itemId})
  });

  const data = await res.json();

  // ---- NO DOUBLE MESSAGES ----
  if(data.status==="match"){
    return; // badge already shown
  }

  if(data.status==="mismatch"){
    toast(`Move ${itemId} → ${data.correctBin}`,"warn");
  }

  if(data.status==="remove-item"){
    setTimeout(()=>{
      toast(`✖ Remove ${itemId}`,"error");
    },250);
  }

  if(data.status==="no-bin"){
    toast(`${itemId} not in CSV`,"error");
  }
}

// --------------------------------------------------
// TOAST
// --------------------------------------------------
let toastTimer=null;

function toast(msg,type="info"){
  const t=document.getElementById("toast");
  if(!t) return;

  clearTimeout(toastTimer);

  t.textContent=msg;
  t.style.display="block";
  t.style.background =
    type==="warn"?"#ffc107":
    type==="error"?"#dc3545":"#6c47ff";

  toastTimer=setTimeout(()=>t.style.display="none",3500);
}

