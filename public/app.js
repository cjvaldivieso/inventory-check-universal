/* public/app.js — Shappi Inventory App (v3.2) */
/* Includes:
   - remove-item UI
   - export visible results
   - download full audit CSV
   - hide Category + Subcategory
   - shrink table layout to avoid scrolling
*/

// -------------------------------
// SOCKET + CSV META HANDLING
// -------------------------------
const socket = io();
const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// Live CSV updates
socket.on("csvUpdated", (meta) => {
  if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV updated • ${meta.total} items`, "info");
});

// Poll on load
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();
    if (d && typeof d.total !== "undefined") {
      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${d.uploadedAt}`;
    }
  } catch {}
})();

// Upload local CSV
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
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;
      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      toast("CSV upload failed", "error");
    }
  });
}

// -------------------------------
// AUDITOR SELECTOR
// -------------------------------
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
      opt.value = saved;
      opt.textContent = saved;
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
        o.value = nn;
        o.textContent = nn;
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

// -------------------------------
// HIDE Expected Bin + Category + Subcategory columns
// -------------------------------
(function hideColumns() {
  const table = document.querySelector("table");
  if (!table) return;

  const hiddenKeys = ["expected bin", "category", "subcategory"];

  const ths = table.querySelectorAll("thead th");
  const hideIndices = [];

  ths.forEach((th, i) => {
    const text = th.textContent.trim().toLowerCase();
    if (hiddenKeys.includes(text)) hideIndices.push(i);
  });

  hideIndices.forEach(i => {
    ths[i].style.display = "none";
    table.querySelectorAll("tbody tr").forEach(tr => {
      const td = tr.children[i];
      if (td) td.style.display = "none";
    });
  });
})();

// -------------------------------
// DOM + UI REFS
// -------------------------------
const currentBinEl   = document.getElementById("currentBin");
const logTbody       = document.getElementById("logTbody");
const scanBinBtn     = document.getElementById("scanBinBtn");
const scanItemBtn    = document.getElementById("scanItemBtn");
const endBinBtn      = document.getElementById("endBinBtn");
const exportVisibleBtn = document.getElementById("exportVisible");
const downloadAuditBtn = document.getElementById("downloadAuditCsv");

let currentBin = null;
let scanning   = false;

// Reduce table font size to avoid horizontal scroll
(function compressTable() {
  const table = document.querySelector("table");
  if (table) {
    table.style.fontSize = "13px";
    table.style.tableLayout = "fixed";
    table.style.width = "100%";
  }
})();

// -------------------------------
// CAMERA PERMISSION PREFETCH
// -------------------------------
(async () => {
  try {
    if (!navigator.permissions) return;
    const status = await navigator.permissions.query({ name: "camera" });
    if (status.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ video: true });
    }
  } catch {}
})();

// -------------------------------
// BUTTON HOOKS
// -------------------------------
if (scanBinBtn)  scanBinBtn.onclick  = () => startQRScan();
if (scanItemBtn) scanItemBtn.onclick = () => startContinuousItemScan();
if (endBinBtn) {
  endBinBtn.onclick = async () => {
    if (!currentBin) return toast("No active bin. Scan a bin first.", "warn");
    await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, { method: "POST" });
    toast(`Audit ended for ${currentBin}`, "info");
    currentBin = null;
    if (currentBinEl) currentBinEl.textContent = "None";
    stopAnyOpenScanner();
  };
}

// -------------------------------
// VIDEO OVERLAY
// -------------------------------
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan Bin";
  title.style = "color: #fff; font-weight: 700; margin: 8px 0 12px;";
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style = "width: 92vw; max-width: 640px; border-radius: 12px;";
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style = `
    margin-top: 16px;
    background: #ff5555;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 10px;
    font-weight: 600;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, title };
}

let activeStream = null;
function stopAnyOpenScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch {}
  activeStream = null;
  document.querySelectorAll(".shappi-scan-overlay").forEach(el => el.remove());
}

// -------------------------------
// BIN SCANNING
// -------------------------------
async function startQRScan() {
  const { overlay, video, stopBtn } = createOverlay();
  let stopped = false;

  stopBtn.onclick = () => { stopped = true; stopAnyOpenScanner(); overlay.remove(); };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }});
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const loop = async () => {
      if (stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });

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

  } catch {
    toast("Camera unavailable", "error");
    overlay.remove();
  }
}

// -------------------------------
// ITEM SCANNING
// -------------------------------
async function startContinuousItemScan() {
  if (!currentBin) return toast("Scan a bin first.", "warn");
  if (scanning) return;

  const { overlay, video, stopBtn } = createOverlay();
  overlay.querySelector("div").textContent = `Scanning Items • Bin ${currentBin}`;

  scanning = true;
  let stopped = false;
  let lastCode = "";
  let coolOff = false;

  stopBtn.onclick = () => {
    stopped = true;
    scanning = false;
    stopAnyOpenScanner();
    overlay.remove();
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }});
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tick = async () => {
      if (stopped || !scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });

        if (code && code.data) {
          const raw = code.data.trim();
          if (!coolOff && raw && raw !== lastCode) {
            lastCode = raw;
            flashOK();
            await handleItemScan(raw);
            coolOff = true;
            setTimeout(() => { coolOff = false; lastCode = ""; }, 800);
          }
        }
      }
      requestAnimationFrame(tick);
    };
    tick();

  } catch {
    toast("Camera error", "error");
    overlay.remove();
  }
}

// -------------------------------
// HANDLE ITEM SCAN → TABLE
// -------------------------------
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
      toast(`✓ ${itemId} OK`, "success");

    } else if (data.status === "mismatch") {
      label = `Wrong Bin → ${data.correctBin}`;
      cls = "yellow";
      toast(`Move ${itemId} to ${data.correctBin}`, "warn");

    } else if (data.status === "no-bin") {
      label = "Not in CSV"; cls = "red";
      toast(`${itemId} not in CSV`, "error");

    } else if (data.status === "remove-item") {
      label = "Remove Item"; cls = "red";
      toast(`REMOVE ${itemId}`, "error");

    } else {
      label = data.status || "Unknown";
      cls = "grey";
    }

    const rec = data.record || {};
    const tr = document.createElement("tr");

    tr.style.fontSize = "13px";

    tr.innerHTML = `
      <td>${itemId}</td>
      <td>${currentBin || "-"}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <!-- HIDDEN COLS -->
      <td style="display:none">${rec.category || "-"}</td>
      <td style="display:none">${rec.subcategory || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>
        ${
          data.status === "mismatch"
            ? `<label><input type="checkbox" class="resolveToggle"
                      data-bin="${currentBin}" data-item="${itemId}"> Move OK</label>`
            : "-"
        }
      </td>
    `;

    logTbody.prepend(tr);

  } catch {
    toast("Scan failed", "error");
  }
}

// -------------------------------
// RESOLUTION TOGGLE
// -------------------------------
if (logTbody) {
  logTbody.addEventListener("change", async (e) => {
    const el = e.target;
    if (!el.classList.contains("resolveToggle")) return;

    const binId = el.getAttribute("data-bin");
    const itemId = el.getAttribute("data-item");

    await fetch("/audit/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId, itemId, resolved: !!el.checked })
    });
  });
}

// Server-broadcast resolution updates
socket.on("itemResolved", ({ binId, itemId, resolved }) => {
  const cb = logTbody.querySelector(
    `input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`
  );
  if (cb) cb.checked = !!resolved;
});

// -------------------------------
// EXPORT ONSCREEN RESULTS
// -------------------------------
if (exportVisibleBtn) {
  exportVisibleBtn.onclick = () => {
    const table = document.querySelector("table");
    if (!table) return;

    const rows = [];
    const headers = [...table.querySelectorAll("thead th")]
      .filter(th => th.style.display !== "none")
      .map(th => th.textContent.trim());

    rows.push(headers);

    [...table.querySelectorAll("tbody tr")].forEach(tr => {
      const cells = [...tr.children]
        .filter(td => td.style.display !== "none")
        .map(td => td.textContent.trim());
      rows.push(cells);
    });

    const csv = rows.map(r => r.map(v => `"${v.replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `shappi_visible_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

// -------------------------------
// DOWNLOAD FULL AUDIT CSV (backend)
// -------------------------------
if (downloadAuditBtn) {
  downloadAuditBtn.onclick = () => {
    window.location.href = "/export-summary";
  };
}

// -------------------------------
// TOAST + FLASH HELPERS
// -------------------------------
function toast(msg, type = "info") {
  let wrap = document.getElementById("shappi-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "shappi-toast-wrap";
    wrap.style = `
      position: fixed;
      left: 50%; bottom: 24px;
      transform: translateX(-50%);
      z-index: 999999;
    `;
    document.body.appendChild(wrap);
  }

  const el = document.createElement("div");
  el.textContent = msg;
  el.style = `
    margin-top: 8px; padding: 8px 12px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: #fff;
    background: ${
      type === "success" ? "#28a745" :
      type === "warn"    ? "#ffc107" :
      type === "error"   ? "#dc3545" : "#6c47ff"
    };
  `;
  wrap.appendChild(el);

  setTimeout(() => el.remove(), 2200);
}

function flashOK() {
  const flash = document.createElement("div");
  flash.style = `
    position: fixed; inset: 0;
    background: rgba(40,167,69,0.28);
    z-index: 999998;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 150);
}

