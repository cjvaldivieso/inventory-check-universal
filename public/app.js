/* public/app.js — Shappi Inventory App (v4.0)
   Includes:
   - Chrome-safe upload system
   - Bin validation (3 letters + exists in CSV)
   - Duplicate scan prevention
   - Update existing rows instead of duplicates
   - Hidden columns: Category / Subcategory / Expected Bin
   - Fully mobile-friendly overlay
   - Audit Status logic
   - Export buttons
*/

// --------------------------------------------------
// GLOBALS: SOCKET + CSV META
// --------------------------------------------------
const socket = io();

const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

let VALID_BINS = [];   // pulled from CSV
let csvLoaded  = false;

// --------------------------------------------------
// SOCKET LISTENER — CSV UPDATED BY ANY USER
// --------------------------------------------------
socket.on("csvUpdated", (meta) => {
  csvLoaded = true;

  if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;

  // Save valid bins for validation
  VALID_BINS = meta.bins || [];

  toast(`CSV updated • ${meta.total} items`, "info");
});

// --------------------------------------------------
// POLL SERVER ON LOAD (for second user)
// --------------------------------------------------
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();

    if (typeof d.total !== "undefined") {
      csvLoaded = d.total > 0;

      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;

      VALID_BINS = d.validBins || [];
    }
  } catch (err) {
    console.error("CSV status check failed", err);
  }
})();
// --------------------------------------------------
// UPLOAD CSV — Chrome-Safe System
// --------------------------------------------------
if (csvUpload) {
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      toast("No file selected", "error");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res  = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();

      if (data.error) {
        toast("CSV upload failed", "error");
        return;
      }

      csvLoaded = true;
      csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
      csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;

      VALID_BINS = data.bins || [];
      toast(`CSV uploaded • ${data.total} items`, "success");

    } catch (err) {
      console.error("CSV upload error", err);
      toast("CSV upload failed", "error");
    }
  });
}

// --------------------------------------------------
// AUDITOR SELECTOR
// --------------------------------------------------
const auditorSelect  = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = `Current User: ${name}`;
}

// Load saved auditor
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

// Change handler
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

// --------------------------------------------------
// DOM REFS
// --------------------------------------------------
const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");

const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");
const endBinBtn    = document.getElementById("endBinBtn");

let currentBin = null;
let scanning   = false;

// --------------------------------------------------
// CAMERA PERMISSION PRELOAD
// --------------------------------------------------
(async () => {
  try {
    if (!navigator.permissions) return;
    const status = await navigator.permissions.query({ name: "camera" });
    if (status.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ video: true });
    }
  } catch {}
})();
// --------------------------------------------------
// OVERLAY (Shared for BIN + ITEM scanning)
// --------------------------------------------------
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding-top: 40px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan Bin QR";
  title.style = `
    color: #fff;
    font-weight: 700;
    margin-bottom: 16px;
    font-size: 20px;
  `;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style = `
    width: 92vw;
    max-width: 650px;
    border-radius: 14px;
  `;
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style = `
    margin-top: 20px;
    background: #ff5555;
    color: #fff;
    border: none;
    padding: 12px 22px;
    border-radius: 12px;
    font-weight: 600;
    font-size: 18px;
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

// --------------------------------------------------
// SCAN BIN (with validation + csv bin check)
// --------------------------------------------------
if (scanBinBtn) scanBinBtn.onclick = () => startQRScan();

async function startQRScan() {
  const { overlay, video, stopBtn } = createOverlay();

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; stopAnyOpenScanner(); overlay.remove(); };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
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
        const code = jsQR(frame.data, frame.width, frame.height);

        if (code && code.data) {
          const BIN = code.data.trim().toUpperCase();

          // Validate: must be exactly 3 letters
          if (!/^[A-Z]{3}$/.test(BIN)) {
            toast("Invalid Bin QR (must be 3 letters)", "error");
            return;
          }

          // Validate: must exist in CSV
          if (!VALID_BINS.includes(BIN)) {
            toast(`Bin ${BIN} not found in CSV`, "error");
            return;
          }

          flashOK();
          currentBin = BIN;
          currentBinEl.textContent = currentBin;

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
    toast("Camera access denied", "error");
    overlay.remove();
  }
}

// --------------------------------------------------
// ITEM SCANNING (duplicate prevention + updated rows)
// --------------------------------------------------
let lastScan = 0;
const SCAN_COOLDOWN = 900;

if (scanItemBtn) scanItemBtn.onclick = () => startContinuousItemScan();

async function startContinuousItemScan() {
  if (!currentBin) return toast("Scan a Bin QR first.", "warn");
  if (scanning) return;

  const { overlay, video, stopBtn, title } = createOverlay();
  title.textContent = `Scanning Items • Bin ${currentBin}`;
  scanning = true;

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    scanning = false;
    stopAnyOpenScanner();
    toast("Stopped scanning", "info");
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const loop = async () => {
      if (stopped || !scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height);

        const now = Date.now();
        if (code && code.data && now - lastScan > SCAN_COOLDOWN) {
          lastScan = now;
          flashOK();
          await handleItemScan(code.data.trim());
        }
      }

      requestAnimationFrame(loop);
    };

    loop();

  } catch (err) {
    console.error("Camera error", err);
    scanning = false;
    toast("Camera error", "error");
  }
}

// --------------------------------------------------
// HANDLE ITEM SCAN (Updates existing rows if found)
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
    const rec = data.record || {};

    let label = "", cls = "";

    if (data.status === "match") {
      label = "Correct Bin"; cls = "green";
      toast(`✓ ${itemId} correct`, "success");

    } else if (data.status === "mismatch") {
      label = `Move → ${data.correctBin}`; cls = "yellow";
      toast(`Move ${itemId} → ${data.correctBin}`, "warn");

    } else if (data.status === "no-bin") {
      label = "Not in CSV"; cls = "red";
      toast(`🚫 ${itemId} not in CSV`, "error");

    } else if (data.status === "remove-item") {
      label = "Remove Item"; cls = "red";
      toast(`🗑️ Remove ${itemId}`, "error");

    } else {
      label = "Unknown"; cls = "grey";
    }

    // Update existing or add new
    let existingRow = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    const columns = `
      <td>${itemId}</td>
      <td style="display:none"></td>
      <td>${currentBin}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td style="display:none"></td>
      <td style="display:none"></td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>${
        data.status === "mismatch"
          ? `<label><input type="checkbox"
                 class="resolveToggle"
                 data-bin="${currentBin}"
                 data-item="${itemId}"> Move</label>`
          : "-"
      }</td>
    `;

    if (existingRow) {
      existingRow.innerHTML = columns;
    } else {
      const tr = document.createElement("tr");
      tr.dataset.item = itemId;
      tr.innerHTML = columns;
      logTbody.prepend(tr);
    }

  } catch (err) {
    console.error("Scan error", err);
    toast("Scan failed", "error");
  }
}

// --------------------------------------------------
// RESOLVE CHECKBOX
// --------------------------------------------------
if (logTbody) {
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
      toast("Failed to update resolve state", "error");
    }
  });
}

// --------------------------------------------------
// EXPORT VISIBLE LOG TO CSV
// --------------------------------------------------
document.getElementById("exportVisible").onclick = () => {
  let csv = "Item ID,Scanned Bin,WH Received,Shappi Status,Audit Status,Resolved\n";
  [...logTbody.children].forEach(row => {
    const cells = [...row.children].map(td => td.innerText.trim());
    csv += `${cells[0]},${cells[2]},${cells[3]},${cells[4]},${cells[7]},${cells[8]}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `shappi_visible_results_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// --------------------------------------------------
// FULL AUDIT CSV
// --------------------------------------------------
document.getElementById("downloadAuditCsv").onclick = () => {
  window.location.href = "/export-summary";
};

// --------------------------------------------------
// VISUAL CONFIRMATION (flash green)
// --------------------------------------------------
function flashOK() {
  const flash = document.createElement("div");
  flash.style = `
    position: fixed; inset: 0;
    background: rgba(40,167,69,0.28);
    z-index: 9998;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 180);
}

// --------------------------------------------------
// TOAST NOTIFICATIONS
// --------------------------------------------------
function toast(msg, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;

  toast.style.display = "block";
  toast.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => { toast.style.display = "none"; }, 2200);
}

