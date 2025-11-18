/* public/app.js — Shappi Inventory App (v3.3) */
/* Includes:
 - remove-item UI
 - export visible results
 - download full audit CSV
 - hide Category + Subcategory columns
 - shrink table layout to avoid scrolling
 - strong debounce to prevent duplicate scans
 - update existing table rows instead of duplicating items
*/

// --------------------------------------------------
// SOCKET + CSV META HANDLING
// --------------------------------------------------
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

// Poll server on load
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

// Upload CSV handler
if (csvUpload) {
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res  = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();

      csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
      csvTimestamp.textContent = `Last Updated: ${data.timestamp}`;
      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      console.error("CSV upload failed", err);
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
    // Ensure dropdown option exists
    if (![...auditorSelect.options].some(o => o.value === saved)) {
      const opt = document.createElement("option");
      opt.value = saved; opt.textContent = saved;
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

// --------------------------------------------------
// DOM Refs
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
// OVERLAY UI
// --------------------------------------------------
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding-top: 40px;
    padding-bottom: 80px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan QR";
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
// BIN SCAN
// --------------------------------------------------
async function startQRScan() {
  const { overlay, video, stopBtn } = createOverlay();

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; stopAnyOpenScanner(); };

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
          flashOK();
          currentBin = code.data.trim();
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
// ITEM SCAN (CONTINUOUS) — WITH DEBOUNCE + ROW UPDATE
// --------------------------------------------------
let lastScan = 0;
const SCAN_COOLDOWN = 900; // ms

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
// SCAN HANDLER — UPDATES EXISTING ROWS
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

    // compute UI label + color
    let label = "", cls = "";
    if (data.status === "match") {
      label = "Correct Bin"; cls = "green";
      toast(`✓ ${itemId} in correct bin`, "success");

    } else if (data.status === "mismatch") {
      label = `Wrong Bin → Move to ${data.correctBin}`; cls = "yellow";
      toast(`Move ${itemId} to ${data.correctBin}`, "warn");

    } else if (data.status === "no-bin") {
      label = "Not in CSV"; cls = "red";
      toast(`🚫 ${itemId} not in CSV`, "error");

    } else if (data.status === "remove-item") {
      label = "Remove Item"; cls = "red";
      toast(`🗑️ Remove ${itemId}`, "error");

    } else {
      label = data.status || "Unknown"; cls = "grey";
    }

    // ---------------------------------------------
    // UPDATE OR INSERT ROW
    // ---------------------------------------------
    let existingRow = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    if (existingRow) {
      // update status only
      existingRow.querySelector(".status-col").innerHTML =
        `<span class="status-pill ${cls}">${label}</span>`;
      return;
    }

    // create new row
    const tr = document.createElement("tr");
    tr.dataset.item = itemId;

    tr.innerHTML = `
      <td>${itemId}</td>
      <td style="display:none"></td>
      <td>${currentBin}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td style="display:none">${rec.category || "-"}</td>
      <td style="display:none">${rec.subcategory || "-"}</td>

      <td class="status-col">
        <span class="status-pill ${cls}">${label}</span>
      </td>

      <td>
        ${
          data.status === "mismatch"
            ? `<label style="cursor:pointer;">
                <input type="checkbox"
                       data-bin="${currentBin}"
                       data-item="${itemId}"
                       class="resolveToggle">
                Mark Moved
               </label>`
            : "-"
        }
      </td>
    `;

    logTbody.prepend(tr);

  } catch (err) {
    console.error("Scan error", err);
    toast("Scan failed", "error");
  }
}

// --------------------------------------------------
// RESOLUTION CHECKBOX
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
    } catch (err) {
      console.error("Resolve update failed", err);
      toast("Failed to update resolve state", "error");
    }
  });
}

// Sync when server updates item resolution
socket.on("itemResolved", ({ binId, itemId, resolved }) => {
  const cb = logTbody.querySelector(
    `input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`
  );
  if (cb) cb.checked = !!resolved;
});

// --------------------------------------------------
// EXPORT VISIBLE (ON-SCREEN)
// --------------------------------------------------
document.getElementById("exportVisible").onclick = () => {
  let csv = "Item ID,Scanned Bin,WH Received,Shappi Status,Audit Status,Resolved\n";

  [...logTbody.children].forEach(row => {
    const cols = [...row.children].map(td => td.innerText.trim());
    csv += `${cols[0]},${cols[2]},${cols[3]},${cols[4]},${cols[7]},${cols[8]}\n`;
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
// DOWNLOAD FULL AUDIT CSV
// --------------------------------------------------
document.getElementById("downloadAuditCsv").onclick = () => {
  window.location.href = "/export-summary";
};

// --------------------------------------------------
// FLASH OK EFFECT
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
// TOAST
// --------------------------------------------------
function toast(msg, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;

  toast.style.display = "block";
  toast.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => { toast.style.display = "none"; }, 2000);
}

