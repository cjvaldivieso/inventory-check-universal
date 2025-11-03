const socket = io();

let currentBin = null;
const logTbody = document.getElementById("logTbody");
const csvInfoEl = document.getElementById("csvInfo");
const auditorSelect = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

// ===== Auditor selector =====
function setAuditor(name){
  if(!name) return;
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = `Current Auditor: ${name}`;
}
function loadAuditor(){
  const saved = localStorage.getItem("auditorName");
  if(saved){
    let opt = Array.from(auditorSelect.options).find(o=>o.value===saved);
    if(!opt){
      const newOpt=document.createElement("option");
      newOpt.value=saved; newOpt.textContent=saved;
      auditorSelect.insertBefore(newOpt, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  }
}
auditorSelect.addEventListener("change", ()=>{
  const v = auditorSelect.value;
  if(v==="__add_new__"){
    const nn = prompt("Enter new auditor name:");
    if(nn){
      const o=document.createElement("option");
      o.value=nn; o.textContent=nn;
      auditorSelect.insertBefore(o, auditorSelect.lastElementChild);
      auditorSelect.value=nn;
      setAuditor(nn);
    }else{
      auditorSelect.value = localStorage.getItem("auditorName") || "";
    }
  }else{
    setAuditor(v);
  }
});
loadAuditor();

// ===== CSV upload & status =====
document.getElementById("csvUpload").addEventListener("change", async (e)=>{
  const file=e.target.files[0];
  if(!file) return;
  const fd=new FormData(); fd.append("file", file);
  const res=await fetch("/upload-csv", {method:"POST", body:fd});
  const data=await res.json();
  csvInfoEl.textContent = `📦 CSV Loaded (${data.total}) • Updated: ${data.timestamp}`;
  alert(`CSV uploaded (${data.total} records)`);
});
socket.on("csvUpdated", d=>{
  csvInfoEl.textContent = `📦 CSV Loaded (${d.total}) • Updated: ${d.timestamp}`;
});
(async ()=>{
  try{
    const r=await fetch("/csv-status"); const d=await r.json();
    if(d.timestamp) csvInfoEl.textContent = `📦 CSV Loaded (${d.total}) • Updated: ${d.timestamp}`;
  }catch{}
})();

// ===== Full-screen camera overlay & scanning =====
async function startQRScan(mode){
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  const overlay=document.createElement("div");
  overlay.className="overlay";

  const video=document.createElement("video");
  overlay.appendChild(video);
  document.body.appendChild(overlay);

  let lastValue=null, lastAt=0;

  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
    video.srcObject=stream;
    await video.play();

    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d");

    const loop = async ()=>{
      if(video.readyState===video.HAVE_ENOUGH_DATA){
        canvas.width=video.videoWidth; canvas.height=video.videoHeight;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const img=ctx.getImageData(0,0,canvas.width,canvas.height);
        const code=jsQR(img.data,img.width,img.height,{inversionAttempts:"dontInvert"});
        if(code){
          const val=code.data.trim();
          const now=Date.now();
          if(val===lastValue && (now-lastAt)<1500){ requestAnimationFrame(loop); return; }
          lastValue=val; lastAt=now;

          if(mode==="bin"){
            stream.getTracks().forEach(t=>t.stop()); overlay.remove();
            currentBin = val;
            document.getElementById("currentBin").textContent = currentBin;
            await fetch(`/audit/start/${encodeURIComponent(currentBin)}?auditor=${encodeURIComponent(auditor)}`, {method:"POST"});
            alert(`✅ Audit started for Bin: ${currentBin}`);
            return;
          }else{
            if(!currentBin){ alert("Scan a Bin QR first!"); }
            else{
              await handleItemScan(val, auditor);
            }
          }
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }catch(err){
    console.error("Camera error:", err);
    alert("Camera access denied or unavailable.");
    overlay.remove();
  }
}

async function handleItemScan(itemId, auditor){
  try{
    const r = await fetch("/audit/scan?auditor="+encodeURIComponent(auditor), {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ binId: currentBin, itemId })
    });
    const data = await r.json();
    const tr=document.createElement("tr");

let label = "", cls = "";
if (data.status === "match") {
  label = "✅ Correct Bin"; cls = "green";
} else if (data.status === "mismatch") {
  label = `⚠️ Wrong Bin → Move to ${data.correctBin || "Unknown"}`; cls = "yellow";
  alert(`⚠️ Item ${itemId} belongs in ${data.correctBin}. Please move it.`);
} else if (data.status === "no-bin") {
  label = "🚫 No Bin (not in CSV)"; cls = "red";
  alert(`⚠️ Item ${itemId} is NOT in the CSV (not registered).`);
} else if (data.status === "missing") {
  label = "❌ Missing (no bin assigned in CSV)"; cls = "grey";
} else {
  label = data.status || "Unknown"; cls = "grey";
}

    const expected = data.correctBin || "-";
    const rec = data.record || {};

    tr.innerHTML = `
      <td>${itemId}</td>
      <td>${expected}</td>
      <td>${currentBin || "-"}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td>${rec.category || "-"}</td>
      <td>${rec.subcategory || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>
        ${data.status==="mismatch"
          ? `<label style="cursor:pointer;">
               <input type="checkbox" data-bin="${currentBin}" data-item="${itemId}" class="resolveToggle"> Resolved
             </label>`
          : "-"
        }
      </td>
    `;
    logTbody.prepend(tr);
  }catch(err){
    console.error(err);
    alert("Scan error.");
  }
}

logTbody.addEventListener("change", async (e)=>{
  const el = e.target;
  if(!el.classList.contains("resolveToggle")) return;
  const binId = el.getAttribute("data-bin");
  const itemId = el.getAttribute("data-item");
  const resolved = !!el.checked;

  try{
    await fetch("/audit/resolve", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ binId, itemId, resolved })
    });
  }catch(err){
    console.error("Resolve update failed", err);
    alert("Failed to update resolve state.");
  }
});

socket.on("itemResolved", ({binId,itemId,resolved})=>{
  const cb = logTbody.querySelector(`input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`);
  if(cb) cb.checked = !!resolved;
});

// Buttons
document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
document.getElementById("scanItemBtn").onclick = () => startQRScan("item");
document.getElementById("endBinBtn").onclick = async ()=>{
  if(!currentBin){ alert("No active bin. Scan a Bin QR first."); return; }
  await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, {method:"POST"});
  alert(`✅ Audit ended for Bin: ${currentBin}`);
  currentBin = null;
  document.getElementById("currentBin").textContent = "None";
};

// Export on-screen results
document.getElementById("exportLogBtn").onclick = ()=>{
  const rows=[["Item ID","Expected Bin","Scanned Bin","WH Received","Shappi Status","Category","Subcategory","Status","Resolved"]];
  logTbody.querySelectorAll("tr").forEach(tr=>{
    const cols=Array.from(tr.querySelectorAll("td")).map(td=>td.textContent.trim());
    rows.push(cols);
  });
  const csv = rows.map(r=>r.map(v=>{
    const s=(v??"").toString(); return s.includes(",")||s.includes("\n")?`"${s.replace(/"/g,'""')}"`:s;
  }).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="audit_results.csv"; a.click();
};

// Export full server-side summary
document.getElementById("exportSummaryBtn").onclick = ()=>{
  window.location.href = "/export-summary";
};

