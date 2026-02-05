/* public/app.js — Shappi Inventory App (v18 FIXED + Battery Saver + Scanner Frame + Pulse + Action Badge)
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
   + Scanner frame: purple corner brackets while scanner is running
   + Visual scan feedback: center ✓ pulse (detectable)
   + UI FIX: single Action Badge above Stop (no overlap, no contradictions)
*/

const socket = io();

// --------------------------------------------------
// CSV META
// --------------------------------------------------
let latestCSVTotal = 0;
let latestCSVTime = null;

const csvInfo = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload = document.getElementById("csvUpload");

// Broadcast CSV changes
socket.on("csvUpdated", (meta) => {
  latestCSVTotal = meta.total;
  latestCSVTime = meta.uploadedAt;

  if (csvInfo) csvInfo.textContent = `📦 CSV Loaded (${meta.total})`;
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
      latestCSVTime = d.uploadedAt;

      if (csvInfo) csvInfo.textContent = `📦 CSV Loaded (${d.total})`;
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
      const res = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();

      latestCSVTotal = data.total;
      latestCSVTime = data.uploadedAt;

      csvInfo.textContent = `📦 CSV Loaded (${data.total})`;
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
const auditorSelect = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditor");

function setAuditor(name) {
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = name;
}

(function initAuditor() {
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
const currentBinEl = document.getElementById("currentBin");
const logTbody = document.getElementById("logTbody");
const scanBinBtn = document.getElementById("scanBinBtn");
const scanItemBtn = document.getElementById("scanItemBtn");
const exportVisibleBtn = document.getElementById("exportVisible");
const fullExportBtn = document.getElementById("downloadAuditCsv");

let currentBin = null;
let scanning = false;
let activeStream = null;

// debounce for items ONLY
let lastScan = 0;
const SCAN_COOLDOWN = 900;

// Battery saver settings (works on iPhone + Android)
const DECODE_INTERVAL_MS = 200; // 5 decodes/sec
const DECODE_MAX_WIDTH = 640;   // downscale image before jsQR
const CAMERA_FPS_IDEAL = 15;    // lower FPS = less power

// --------------------------------------------------
// CAMERA OVERLAY UI
// --------------------------------------------------
function createOverlay(titleText) {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center;
    padding-top: 28px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = titleText;
  title.style = `
    color:#fff; font-weight:800; font-size:26px;
    margin: 10px 0 14px;
    text-align:center;
  `;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style = `
    width:92vw; max-width:650px;
    border-radius:22px;
    background:#000;
  `;
  overlay.appendChild(video);

  // Scanner frame (purple corner brackets)
  const frame = document.createElement("div");
  frame.style = `
    position: fixed;
    width: 78vw;
    max-width: 560px;
    aspect-ratio: 1 / 1;
    top: 56%;
    left: 50%;
    transform: translate(-50%, -45%);
    pointer-events: none;
    z-index: 10000;
  `;

  const cornerBase = `
    position:absolute;
    width:44px; height:44px;
    border-color:#6c47ff;
    border-style:solid;
    border-width:0;
  `;

  const tl = document.createElement("div");
  tl.style = cornerBase + `top:0; left:0; border-top-width:7px; border-left-width:7px; border-radius:12px 0 0 0;`;

  const tr = document.createElement("div");
  tr.style = cornerBase + `top:0; right:0; border-top-width:7px; border-right-width:7px; border-radius:0 12px 0 0;`;

  const bl = document.createElement("div");
  bl.style = cornerBase + `bottom:0; left:0; border-bottom-width:7px; border-left-width:7px; border-radius:0 0 0 12px;`;

  const br = document.createElement("div");
  br.style = cornerBase + `bottom:0; right:0; border-bottom-width:7px; border-right-width:7px; border-radius:0 0 12px 0;`;

  frame.appendChild(tl);
  frame.appendChild(tr);
  frame.appendChild(bl);
  frame.appendChild(br);
  overlay.appendChild(frame);

  // Center pulse ✓ (quick, but visible)
  const pulse = document.createElement("div");
  pulse.textContent = "✓";
  pulse.style = `
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%) scale(0.85);
    width: 140px; height: 140px;
    border-radius: 999px;
    background: rgba(0,0,0,0.55);
    border: 4px solid #28a745;
    color: #28a745;
    font-size: 84px;
    font-weight: 900;
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 11000;
    opacity: 1;
  `;
  overlay.appendChild(pulse);

  // Action badge (ONLY per-scan message) — above Stop
  const action = document.createElement("div");
  action.style = `
    position: fixed;
    bottom: 120px; /* ABOVE Stop */
    left: 50%;
    transform: translateX(-50%);
    background: rgba(30,41,59,0.98);
    border: 2px solid #6c47ff;
    color: #fff;
    font-weight: 900;
    font-size: 20px;
    padding: 12px 18px;
    border-radius: 16px;
    display: none;
    min-width: 260px;
    max-width: 92vw;
    text-align: center;
    z-index: 11000;
    box-shadow: 0 10px 26px rgba(0,0,0,0.45);
  `;
  overlay.appendChild(action);

  // Stop button fixed at bottom
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop";
  stopBtn.style = `
    position: fixed;
    bottom: 36px;
    left: 50%;
    transform: translateX(-50%);
    width: 78vw;
    max-width: 420px;
    background:#ff5555;
    border:none;
    color:#fff;
    font-size:22px;
    padding:16px 22px;
    border-radius:18px;
    font-weight:800;
    z-index: 12000;
    box-shadow: 0 10px 26px rgba(0,0,0,0.45);
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, pulse, action };
}

function stopScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch (e) {}
  activeStream = null;
  scanning = false;
  document.querySelectorAll(".shappi-scan-overlay")?.forEach(o => o.remove());
}

function showScanPulse(pulseEl) {
  if (!pulseEl) return;
  pulseEl.style.display = "flex";
  pulseEl.style.opacity = "1";
  pulseEl.style.transform = "translate(-50%, -50%) scale(1.0)";

  setTimeout(() => {
    pulseEl.style.opacity = "0";
    pulseEl.style.transform = "translate(-50%, -50%) scale(1.12)";
  }, 260);

  setTimeout(() => {
    pulseEl.style.display = "none";
    pulseEl.style.opacity = "1";
    pulseEl.style.transform = "translate(-50%, -50%) scale(0.85)";
  }, 520);
}

let actionTimer1 = null;
let actionTimer2 = null;

function showAction(actionEl, message, mode = "info") {
  if (!actionEl) return;

  if (actionTimer1) clearTimeout(actionTimer1);
  if (actionTimer2) clearTimeout(actionTimer2);

  // Color by mode (no contradictions)
  const bg =
    mode === "success" ? "rgba(40,167,69,0.95)" :
    mode === "warn"    ? "rgba(255,193,7,0.95)" :
    mode === "error"   ? "rgba(220,53,69,0.95)" :
                         "rgba(30,41,59,0.98)";

  const border =
    mode === "success" ? "#1f7a34" :
    mode === "warn"    ? "#c89a00" :
    mode === "error"   ? "#9b1c2c" :
                         "#6c47ff";

  actionEl.textContent = message;
  actionEl.style.background = bg;
  actionEl.style.borderColor = border;
  actionEl.style.display = "block";
  actionEl.style.opacity = "1";

  // visible long enough to read
  actionTimer1 = setTimeout(() => {
    actionEl.style.opacity = "0";
  }, 1400);

  actionTimer2 = setTimeout(() => {
    actionEl.style.display = "none";
    actionEl.style.opacity = "1";
  }, 1700);
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
// SCAN BIN
// --------------------------------------------------
scanBinBtn.onclick = () => startBinScan();

async function startBinScan() {
  stopScanner();

  const { overlay, video, stopBtn, pulse, action } = createOverlay("Scan Bin QR");
  let stopped = false;

  stopBtn.onclick = () => { stopped = true; stopScanner(); };

  try {
    activeStream = await getCameraStream();
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
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
              const bin = code.data.trim().toUpperCase();
              showScanPulse(pulse);

              // Pattern check
              if (!isValidBin(bin)) {
                showAction(action, `✖ Invalid Bin (must be AAA)`, "error");
                requestAnimationFrame(loop);
                return;
              }

              // Existence check in CSV
              try {
                const resp = await fetch(`/validate-bin/${encodeURIComponent(bin)}`);
                const info = await resp.json();
                if (!info.valid) {
                  showAction(action, `✖ Bin ${bin} not found in CSV`, "error");
                  requestAnimationFrame(loop);
                  return;
                }
              } catch (e) {
                console.error("Bin validation failed", e);
                showAction(action, `✖ Unable to validate bin`, "error");
                requestAnimationFrame(loop);
                return;
              }

              // Bin is valid → start audit
              currentBin = bin;
              currentBinEl.textContent = bin;

              overlay.remove();
              stopScanner();

              const auditor = localStorage.getItem("auditorName") || "Unknown";
              await fetch(`/audit/start/${encodeURIComponent(bin)}?auditor=${encodeURIComponent(auditor)}`, {
                method: "POST"
              });

              toast(`Bin ${bin} selected`, "success");
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
// ITEM SCANNING
// --------------------------------------------------
scanItemBtn.onclick = () => startItemScan();

async function startItemScan() {
  if (!currentBin) return toast("Scan a bin first.", "warn");

  stopScanner();
  scanning = true;

  const { overlay, video, stopBtn, pulse, action } = createOverlay(`Scanning Items • Bin ${currentBin}`);
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
    const ctx = canvas.getContext("2d");
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

              const id = code.data.trim();
              showScanPulse(pulse);

              // Immediate feedback will come from server result via handleItemScan()
              await handleItemScan(id, action);
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
// HANDLE ITEM SCAN → update table row + show ONE action message
// --------------------------------------------------
async function handleItemScan(itemId, actionEl) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  try {
    const res = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId })
    });

    const data = await res.json();
    const rec = data.record || {};

    let label = "";
    let cls = "";

    // Only ONE per-scan message: Action Badge (no toast spam)
    if (data.status === "match") {
      label = "Correct"; cls = "green";
      showAction(actionEl, `✓ ${itemId} • Correct`, "success");
    } else if (data.status === "mismatch") {
      label = `Move → ${data.correctBin}`; cls = "yellow";
      showAction(actionEl, `Move ${itemId} → ${data.correctBin}`, "warn");
    } else if (data.status === "remove-item") {
      label = "Remove"; cls = "red";
      // black X, as requested
      showAction(actionEl, `✖ Remove ${itemId}`, "error");
    } else if (data.status === "no-bin") {
      label = "No CSV"; cls = "red";
      showAction(actionEl, `${itemId} not in CSV`, "error");
    } else {
      label = data.status || "Unknown";
      cls = "grey";
      showAction(actionEl, `${itemId} • ${label}`, "info");
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

  const binId = el.getAttribute("data-bin");
  const itemId = el.getAttribute("data-item");
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
  const url = URL.createObjectURL(blob);

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
// TOAST (system events only)
// --------------------------------------------------
let toastTimer = null;

function toast(msg, type = "info") {
  const t = document.getElementById("toast");
  if (!t) return;

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

