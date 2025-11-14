k/* public/app.js — Shappi Inventory App (hands-free scanning) */

// ----- Socket & CSV UI wiring -----
const socket = io();
const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// Live CSV updates from server
socket.on("csvUpdated", (meta) => {
  if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV updated • ${meta.total} items`, "info");
});

// Poll server once on load
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();
    if (d && typeof d.total !== "undefined") {
      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${d.timestamp || "(none)"}`;
    }
  } catch {}
})();

// CSV upload
if (csvUpload) {
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res  = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();
      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${data.timestamp || data.uploadedAt}`;
      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      console.error("CSV upload failed", err);
      toast("CSV upload failed", "error");
    }
  });
}

// ----- Auditor selector -----
const auditorSelect  = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  if (auditorDisplay) auditorDisplay.textContent = `Current User: ${name}`;
}
(function loadAuditor() {
  if (!auditorSelect) return;
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    if (![...auditorSelect.options].some(o => o.value === saved)) {
      const opt = document.createElement("option");
      opt.value = saved; opt.textContent = saved;
      auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  }
})();
if (auditorSelect) {
  auditorSelect.addEventListener("change", () => {
    const v = auditorSelect.value;
    if (v === "__add_new__") {
      const nn = prompt("Enter new user name:");
      if (nn) {
        const o = document.createElement("option");
        o.value = nn; o.textContent = nn;
        auditorSelect.insertBefore(o, auditorSelect.lastElementChild);
        auditorSelect.value = nn;
        setAuditor(nn);
      } else {
        auditorSelect.value = localStorage.getItem("auditorName") || "";
      }
    } else {
      setAuditor(v);
    }
  });
}

// ----- Hide Expected Bin column -----
(function hideExpectedBinColumn() {
  const table = document.querySelector("table");
  if (!table) return;
  const ths = table.querySelectorAll("thead th");
  let idx = -1;
  ths.forEach((th, i) => {
    if (String(th.textContent).toLowerCase().includes("expected bin")) idx = i;
  });
  if (idx >= 0) {
    ths[idx].style.display = "none";
    table.querySelectorAll("tbody tr").forEach(tr => {
      const td = tr.children[idx];
      if (td) td.style.display = "none";
    });
  }
})();

// ----- DOM refs & state -----
const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");
const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");
const endBinBtn    = document.getElementById("endBinBtn");

let currentBin = null;
let scanning   = false;

// ----- Camera permission pre-check -----
(async () => {
  try {
    if (!navigator.permissions) return;
    const status = await navigator.permissions.query({ name: "camera" });
    if (status.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ video: true });
    }
  } catch {}
})();

// ----- Button wiring -----
if (scanBinBtn)  scanBinBtn.onclick  = () => startQRScan("bin");
if (scanItemBtn) scanItemBtn.onclick = () => startContinuousItemScan();

if (endBinBtn) {
  endBinBtn.onclick = async () => {
    if (!currentBin) return toast("No active bin. Scan a Bin QR first.", "warn");
    await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, { method: "POST" });
    toast(`Audit ended for ${currentBin}`, "info");
    currentBin = null;
    if (currentBinEl) currentBinEl.textContent = "None";
    stopAnyOpenScanner();
  };
}

// ----- Overlay builder -----
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.92)";
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "9999";

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan Bin";
  title.style.color = "#fff";
  title.style.fontWeight = "700";
  title.style.margin = "8px 0 12px";
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style.width = "92vw";
  video.style.maxWidth = "640px";
  video.style.borderRadius = "12px";
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style.marginTop = "16px";
  stopBtn.style.background = "#ff5555";
  stopBtn.style.color = "#fff";
  stopBtn.style.border = "none";
  stopBtn.style.padding = "10px 20px";
  stopBtn.style.borderRadius = "10px";
  stopBtn.style.fontWeight = "600";
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, title };
}

let activeStream = null;
function stopAnyOpenScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch {}
  activeStream = null;
}

// ----- Single bin scan -----
async function startQRScan(kind) {
  const { overlay, video, stopBtn, title } = createOverlay();
  overlay.className = "shappi-scan-overlay";

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; stopAnyOpenScanner(); overlay.remove(); };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const loop = async () => {
      if (stopped) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });

        if (code && code.data) {
          flashOK();
          currentBin = code.data.trim();
          if (currentBinEl) currentBinEl.textContent = currentBin;
          overlay.remove();
          stopAnyOpenScanner();

          const auditor = localStorage.getItem("auditorName") || "Unknown";
          await fetch(`/audit/start/${encodeURIComponent(currentBin)}?auditor=${encodeURIComponent(auditor)}`, {
            method: "POST"
          });
          toast(`Bin set: ${currentBin}`, "success");

          startContinuousItemScan();
          return;
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    console.error("Camera error", err);
    toast("Camera access denied or unavailable", "error");
    overlay.remove();
  }
}

// ----- CONTINUOUS ITEM SCAN -----
async function startContinuousItemScan() {
  if (!currentBin) return toast("Scan a Bin QR first.", "warn");
  if (scanning) return;

  const { overlay, video, stopBtn, title } = createOverlay();
  overlay.className = "shappi-scan-overlay";
  title.textContent = `Scanning Items • Bin ${currentBin}`;

  scanning = true;
  let stopped = false;
  let lastCode = "";
  let coolOff  = false;

  stopBtn.onclick = () => {
    stopped = true;
    scanning = false;
    stopAnyOpenScanner();
    overlay.remove();
    toast("Stopped scanning", "info");
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tick = async () => {
      if (stopped || !scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });

        if (code && code.data) {
          const raw = (code.data || "").trim();
          if (!coolOff && raw && raw !== lastCode) {
            flashOK();
            lastCode = raw;
            await handleItemScan(raw);
            coolOff = true;
            setTimeout(() => { coolOff = false; lastCode = ""; }, 900);
          }
        }
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    console.error("Camera error", err);
    scanning = false;
    toast("Camera access denied or unavailable", "error");
    overlay.remove();
  }
}

// ----- PROCESS ITEM SCAN → UI UPDATE -----
async function handleItemScan(itemId) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";
  try {
    const res = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId })
    });

    const data = await res.json();

    let label = "", cls = "";
    if (data.status === "match") {
      label = "Correct Bin"; cls = "green";
      toast(`✓ ${itemId} in correct bin`, "success");
    }
    else if (data.status === "mismatch") {
      label = `Wrong Bin → Move to ${data.correctBin || "Unknown"}`; cls = "yellow";
      toast(`Move ${itemId} to ${data.correctBin}`, "warn");
    }
    else if (data.status === "no-bin") {
      label = "No Bin (not in CSV)"; cls = "red";
      toast(`🚫 ${itemId} not in CSV`, "error");
    }
    else if (data.status === "remove-item") {
      label = "REMOVE ITEM"; cls = "red";
      toast(`❌ ${itemId} closed/canceled → REMOVE FROM BIN`, "error");
    }
    else if (data.status === "missing") {
      label = "Missing"; cls = "grey";
    }
    else {
      label = data.status || "Unknown"; cls = "grey";
    }

    const rec = data.record || {};
    const tr  = document.createElement("tr");

    tr.innerHTML = `
      <td>${itemId}</td>
      <td>${currentBin || "-"}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td>${rec.category || "-"}</td>
      <td>${rec.subcategory || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>
        ${data.status === "mismatch"
          ? `<label style="cursor:pointer;">
               <input type="checkbox" data-bin="${currentBin}" data-item="${itemId}" class="resolveToggle">
               Mark Moved
             </label>`
          : "-"
        }
      </td>
    `;

    logTbody.prepend(tr);
  } catch (err) {
    console.error("Scan error", err);
    toast("Scan error", "error");
  }
}

// ----- Resolve toggle -----
if (logTbody) {
  logTbody.addEventListener("change", async (e) => {
    const el = e.target;
    if (!el.classList.contains("resolveToggle")) return;
    const binId   = el.getAttribute("data-bin");
    const itemId  = el.getAttribute("data-item");
    const resolved = !!el.checked;

    try {
      await fetch("/audit/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ binId, itemId, resolved })
      });
    } catch (err) {
      console.error("Resolve update failed", err);
      toast("Failed to update resolve state", "error");
    }
  });
}

socket.on("itemResolved", ({ binId, itemId, resolved }) => {
  const cb = logTbody.querySelector(`input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`);
  if (cb) cb.checked = !!resolved;
});

// ----- Toast helper -----
function toast(msg, type = "info") {
  let wrap = document.getElementById("shappi-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "shappi-toast-wrap";
    wrap.style.position = "fixed";
    wrap.style.left = "50%";
    wrap.style.bottom = "24px";
    wrap.style.transform = "translateX(-50%)";
    wrap.style.zIndex = "10000";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.marginTop = "8px";
  el.style.padding = "10px 14px";
  el.style.borderRadius = "10px";
  el.style.fontWeight = "600";
  el.style.color = "#fff";
  el.style.boxShadow = "0 4px 14px rgba(0,0,0,.3)";
  el.style.background = (
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff"
  );
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// Green flash on successful QR capture
function flashOK() {
  const flash = document.createElement("div");
  flash.style.position = "fixed";
  flash.style.inset = "0";
  flash.style.background = "rgba(40,167,69,0.28)";
  flash.style.zIndex = "9998";
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 180);
}

