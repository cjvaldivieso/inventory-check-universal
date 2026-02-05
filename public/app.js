/* public/app.js — Shappi Inventory App (v18 final, FIXED + Battery Saver + Scan Pulse + Scanner Frame)
   Contains:
   ✓ Chrome desktop CSV upload fix
   ✓ Working bin & item QR scanner
   ✓ Auto-start item scanning after bin scan
   ✓ "Scan Item QR" fallback mode
   ✓ Bin format validation (AAA only)
   ✓ Bin must exist in CSV (server validation)
   ✓ Strong debounce to prevent duplicate reads
   ✓ Updated table columns (Item, Bin, WH Received, Status, Audit, Resolved)
   ✓ “Export Table” / “Export Full Audit”
   + Battery saver: throttled decode + downscaled frames + lower camera FPS
   + Visual scan feedback: center ✓ pulse (longer)
   + Scanner frame: purple corner brackets while scanner is running
*/

const socket = io();

// --------------------------------------------------
// CSV META
// --------------------------------------------------
let latestCSVTotal = 0;
let latestCSVTime  = null;

const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// Broadcast CSV changes
socket.on("csvUpdated", (meta) => {
  latestCSVTotal = meta.total;
  latestCSVTime  = meta.uploadedAt;

  if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;

  toast(`CSV updated • ${meta.total} items`, "info");
});

// Initial CSV status (for ALL users)
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();

    if (typeof d.total !== "undefined") {
      latestCSVTotal = d.total;
      latestCSVTime  = d.uploadedAt;

      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;
    }
  } catch (err) {
    console.error("csv-status error", err);
  }
})();

// --------------------------------------------------
// CSV UPLOAD
// --------------------------------------------------
if (csvUpload) {
  // allow selecting same file twice
  csvUpload.addEventListener("click", (e) => {
    e.stopPropagation();
    e.target.value = "";
  });

  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res  = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();

      latestCSVTotal = data.total;
      latestCSVTime  = data.uploadedAt;

      csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
      csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;

      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      console.error("CSV upload failed", err);
      toast("CSV failed to upload", "error");
    }
  });
}

// --------------------------------------------------
// AUDITOR SELECTOR
// --------------------------------------------------
const auditorSelect  = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditor");

function setAuditor(name) {
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = name;
}

(function initAuditor(){
  if (!auditorSelect) return;
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    auditorSelect.value = saved;
    setAuditor(saved);
  }
})();

auditorSelect?.addEventListener("change", () => {
  const v = auditorSelect.value;

  if (v === "__add_new__") {
    const newName = prompt("Enter new user name:");
    if (newName) {
      const opt = document.createElement("option");
      opt.value = newName;
      opt.textContent = newName;
      auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
      auditorSelect.value = newName;
      setAuditor(newName);
    } else {
      auditorSelect.value = localStorage.getItem("auditorName") || "";
    }
  } else {
    setAuditor(v);
  }
});

// --------------------------------------------------
// DOM REFS & STATE
// --------------------------------------------------
const currentBinEl      = document.getElementById("currentBin");
const logTbody          = document.getElementById("logTbody");
const scanBinBtn        = document.getElementById("scanBinBtn");
const scanItemBtn       = document.getElementById("scanItemBtn");
const exportVisibleBtn  = document.getElementById("exportVisible");
const fullExportBtn     = document.getElementById("downloadAuditCsv");

let currentBin   = null;
let scanning     = false;
let activeStream = null;

// duplicate-scan debounce for items ONLY
let lastScan     = 0;
const SCAN_COOLDOWN = 900;

// Battery saver settings (works on iPhone + Android)
const DECODE_INTERVAL_MS = 200; // 5 decodes/sec
const DECODE_MAX_WIDTH   = 640; // downscale image before jsQR
const CAMERA_FPS_IDEAL   = 15;  // lower FPS = less power

// --------------------------------------------------
// CAMERA OVERLAY
// --------------------------------------------------
function createOverlay(titleText) {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center;
    padding-top: 40px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = titleText;
  title.style = `
    color:#fff; font-weight:700; font-size:20px;
    margin-bottom:14px;
  `;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style = `
    width:92vw; max-width:650px;
    border-radius:14px;
  `;
  overlay.appendChild(video);

  // Scanner frame (purple corner brackets)
  const frame = document.createElement("div");
  frame.className = "scan-frame";
  frame.style = `
    position: absolute;
    width: 72vw;
    max-width: 520px;
    aspect-ratio: 1 / 1;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -35%);
    pointer-events: none;
    z-index: 9999;
  `;

  const cornerBase = `
    position:absolute;
    width:38px; height:38px;
    border-color:#6c47ff;
    border-style:solid;
    border-width:0;
  `;

  const tl = document.createElement("div");
  tl.style = cornerBase + `top:0; left:0; border-top-width:6px; border-left-width:6px; border-radius:10px 0 0 0;`;

  const tr = document.createElement("div");
  tr.style = cornerBase + `top:0; right:0; border-top-width:6px; border-right-width:6px; border-radius:0 10px 0 0;`;

  const bl = document.createElement("div");
  bl.style = cornerBase + `bottom:0; left:0; border-bottom-width:6px; border-left-width:6px; border-radius:0 0 0 10px;`;

  const br = document.createElement("div");
  br.style = cornerBase + `bottom:0; right:0; border-bottom-width:6px; border-right-width:6px; border-radius:0 0 10px 0;`;

  frame.appendChild(tl);
  frame.appendChild(tr);
  frame.appendChild(bl);
  frame.appendChild(br);
  overlay.appendChild(frame);

  // Visual scan feedback (center pulse ✓) — longer display
  const pulse = document.createElement("div");
  pulse.className = "scan-pulse";
  pulse.textContent = "✓";
  pulse.style = `
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%) scale(0.9);
    width: 120px; height: 120px;
    border-radius: 999px;
    background: rgba(0,0,0,0.55);
    border: 3px solid #28a745;
    color: #28a745;
    font-size: 76px;
    font-weight: 800;
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    opacity: 1;
  `;
  overlay.appendChild(pulse);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop";
  stopBtn.style = `
    margin-top:18px; background:#ff5555;
    border:none;color:#fff;font-size:18px;
    padding:12px 22px;border-radius:12px;
    font-weight:600;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, pulse, frame };
}

function stopScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch(e){}
  activeStream = null;
  scanning     = false;
  document.querySelectorAll(".shappi-scan-overlay")?.forEach(o => o.remove());
}

function showScanPulse(pulseEl) {
  if (!pulseEl) return;

  pulseEl.style.display = "flex";
  pulseEl.style.opacity = "1";
  pulseEl.style.transform = "translate(-50%, -50%) scale(1.0)";

  // Hold longer so it’s detectable
  setTimeout(() => {
    pulseEl.style.opacity = "0";
    pulseEl.style.transform = "translate(-50%, -50%) scale(1.12)";
  }, 350);

  setTimeout(() => {
    pulseEl.style.display = "none";
    pulseEl.style.opacity = "1";
    pulseEl.style.transform = "translate(-50%, -50%) scale(0.9)";
  }, 650);
}

async function getCameraStream() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      frameRate: { ideal: CAMERA_FPS_IDEAL, max: 20 },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  });
}

function drawDownscaledFrame(video, canvas, ctx) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, DECODE_MAX_WIDTH / vw);
  const cw = Math.floor(vw * scale);
  const ch = Math.floor(vh * scale);

  canvas.width = cw;
  canvas.height = ch;

  ctx.drawImage(video, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

// --------------------------------------------------
// BIN VALIDATION
// --------------------------------------------------
function isValidBin(bin) {
  return /^[A-Za-z]{3}$/.test(bin);
}

// --------------------------------------------------
// SCAN BIN → validate → auto-start item scanner
// --------------------------------------------------
scanBinBtn.onclick = () => startBinScan();

async function startBinScan() {
  stopScanner();

  const { overlay, video, stopBtn, pulse } = createOverlay("Scan Bin QR");
  let stopped = false;

  stopBtn.onclick = () => { stopped = true; stopScanner(); };

  try {
    activeStream = await getCameraStream();
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");
    let lastDecode = 0;

    const loop = async () => {
      if (stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const now = Date.now();
        if (now - lastDecode >= DECODE_INTERVAL_MS) {
          lastDecode = now;

          const frame = drawDownscaledFrame(video, canvas, ctx);
          if (frame) {
            const code = jsQR(frame.data, frame.width, frame.height);

            if (code && code.data) {
              showScanPulse(pulse);

              const bin = code.data.trim().toUpperCase();

              // 1) Pattern check
              if (!isValidBin(bin)) {
                toast("Invalid Bin — must be 3 letters (AAA)", "error");
                requestAnimationFrame(loop);
                return;
              }

              // 2) Existence check in CSV (server-side)
              try {
                const resp  = await fetch(`/validate-bin/${encodeURIComponent(bin)}`);
                const info  = await resp.json();
                if (!info.valid) {
                  toast("Bin not found in CSV", "error");
                  requestAnimationFrame(loop);
                  return;
                }
              } catch (e) {
                console.error("Bin validation failed", e);
                toast("Unable to validate bin (check CSV)", "error");
                requestAnimationFrame(loop);
                return;
              }

              // 3) Bin is valid → start audit
              currentBin = bin;
              currentBinEl.textContent = bin;

              overlay.remove();
              stopScanner();

              const auditor = localStorage.getItem("auditorName") || "Unknown";
              await fetch(`/audit/start/${encodeURIComponent(bin)}?auditor=${encodeURIComponent(auditor)}`, {
                method: "POST"
              });

              toast(`Bin ${bin} selected`, "success");

              // Auto-start item scanning
              startItemScan();
              return;
            }
          }
        }
      }

      requestAnimationFrame(loop);
    };

    loop();

  } catch (err) {
    console.error("Camera error", err);
    toast("Camera unavailable", "error");
    overlay.remove();
  }
}

// --------------------------------------------------
// ITEM SCANNING (auto + fallback button)
// --------------------------------------------------
scanItemBtn.onclick = () => startItemScan();  // fallback manual

async function startItemScan() {
  if (!currentBin) return toast("Scan a bin first.", "warn");

  stopScanner();
  scanning = true;

  const { overlay, video, stopBtn, pulse } = createOverlay(`Scanning Items • Bin ${currentBin}`);
  let stopped = false;

  stopBtn.onclick = () => {
    stopped = true;
    stopScanner();
    toast("Stopped", "info");
  };

  try {
    activeStream = await getCameraStream();
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");
    let lastDecode = 0;

    const loop = async () => {
      if (!scanning || stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const now = Date.now();
        if (now - lastDecode >= DECODE_INTERVAL_MS) {
          lastDecode = now;

          const frame = drawDownscaledFrame(video, canvas, ctx);
          if (frame) {
            const code = jsQR(frame.data, frame.width, frame.height);

            if (code && code.data && now - lastScan > SCAN_COOLDOWN) {
              lastScan = now;

              showScanPulse(pulse);

              const id = code.data.trim();
              flashOK();
              await handleItemScan(id);
            }
          }
        }
      }

      requestAnimationFrame(loop);
    };

    loop();

  } catch (err) {
    console.error("Camera error", err);
    toast("Camera error", "error");
    stopScanner();
  }
}

// --------------------------------------------------
// HANDLE ITEM SCAN → update table row
// --------------------------------------------------
async function handleItemScan(itemId) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  try {
    const res = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId })
    });

    const data = await res.json();
    const rec  = data.record || {};

    let label = "";
    let cls   = "";

    if (data.status === "match") {
      label = "Correct"; cls = "green";
      toast(`✓ ${itemId}`, "success");
    } else if (data.status === "mismatch") {
      label = `Move → ${data.correctBin}`; cls = "yellow";
      toast(`Move ${itemId} → ${data.correctBin}`, "warn");
    } else if (data.status === "remove-item") {
      label = "Remove"; cls = "red";
      toast(`✖ Remove ${itemId}`, "error");
    } else if (data.status === "no-bin") {
      label = "No CSV"; cls = "red";
      toast(`${itemId} not in CSV`, "error");
    } else {
      label = data.status || "Unknown";
      cls   = "grey";
    }

    // Update or insert table row
    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    const html = `
      <td>${itemId}</td>
      <td style="display:none;">${rec.expectedBin || "-"}</td>
      <td>${currentBin}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>${
        data.status === "mismatch"
          ? `<label>
               <input type="checkbox"
                      class="resolveToggle"
                      data-bin="${currentBin}"
                      data-item="${itemId}"> Move
             </label>`
          : "-"
      }</td>
    `;

    if (row) {
      row.innerHTML = html;
    } else {
      const tr = document.createElement("tr");
      tr.dataset.item = itemId;
      tr.innerHTML = html;
      logTbody.prepend(tr);
    }

  } catch (err) {
    console.error("Scan error", err);
    toast("Scan failed", "error");
  }
}

// --------------------------------------------------
// RESOLVE MOVE
// --------------------------------------------------
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
  } catch {
    toast("Failed to update", "error");
  }
});

// --------------------------------------------------
// EXPORT TABLE (VISIBLE COLUMNS ONLY)
// --------------------------------------------------
exportVisibleBtn.onclick = () => {
  let csv = "Item,Bin,WH Received,Status,Audit,Resolved\n";

  [...logTbody.children].forEach(row => {
    const c = [...row.children].map(td => td.innerText.trim());
    csv += `${c[0]},${c[2]},${c[3]},${c[4]},${c[5]},${c[6]}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `shappi_table_${Date.now()}.csv`;
  a.click();

  URL.revokeObjectURL(url);
};

// --------------------------------------------------
// FULL AUDIT EXPORT
// --------------------------------------------------
fullExportBtn.onclick = () => {
  window.location.href = "/export-summary";
};

// --------------------------------------------------
// VISUAL FLASH
// --------------------------------------------------
function flashOK() {
  const d = document.createElement("div");
  d.style = `
    position:fixed; inset:0;
    background:rgba(40,167,69,0.25);
    z-index:9998;
  `;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 180);
}

// --------------------------------------------------
// TOAST
// --------------------------------------------------

// Single global timer so rapid scans don't cancel new toasts early
let toastTimer = null;

function toast(msg, type = "info") {
  const t = document.getElementById("toast");

  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  t.textContent = msg;
  t.style.display = "block";

  t.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  toastTimer = setTimeout(() => { t.style.display = "none"; }, 5000);
}

