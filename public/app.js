/* public/app.js — Shappi WH Inventory App v4.1
 * - CSV upload + live status
 * - Auditor selector (localStorage)
 * - Bin QR scan (3-letter + server validation)
 * - Item QR scan (debounced, no duplicates per bin)
 * - Hidden Expected Bin / Category / Subcategory columns
 * - Export visible table + full audit CSV
 */

const socket = io();

// --------------------------------------------------
// CSV META (header)
// --------------------------------------------------
const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// Live updates when ANY user uploads a CSV
socket.on("csvUpdated", (meta) => {
  if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV updated • ${meta.total} items`, "info");
});

// On load, ask backend for current CSV meta
(async () => {
  try {
    const res = await fetch("/csv-status");
    if (!res.ok) return;
    const d = await res.json();
    if (typeof d.total !== "undefined") {
      if (csvInfo) {
        csvInfo.textContent = `📦 CSV Loaded (${d.total})`;
      }
      if (csvTimestamp) {
        const ts = d.uploadedAt || d.timestamp || "(none)";
        csvTimestamp.textContent = `Last Updated: ${ts}`;
      }
    }
  } catch (err) {
    console.error("csv-status error", err);
  }
})();

// Local CSV upload (desktop + mobile)
if (csvUpload) {
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res  = await fetch("/upload-csv", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }

      const data = await res.json();
      if (csvInfo)      csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;
      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      console.error("CSV upload failed", err);
      toast("CSV upload failed", "error");
    } finally {
      // Allow selecting same file again if needed
      e.target.value = "";
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
  if (auditorDisplay) {
    auditorDisplay.textContent = `Current User: ${name}`;
  }
}

(function loadAuditor() {
  if (!auditorSelect) return;

  const saved = localStorage.getItem("auditorName");
  if (saved) {
    // ensure option exists
    if (![...auditorSelect.options].some(o => o.value === saved)) {
      const opt = document.createElement("option");
      opt.value = saved;
      opt.textContent = saved;
      auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  } else if (auditorDisplay) {
    auditorDisplay.textContent = "Current User: None";
  }
})();

if (auditorSelect) {
  auditorSelect.addEventListener("change", () => {
    const v = auditorSelect.value;
    if (v === "__add_new__") {
      const nn = prompt("Enter new user name:");
      if (nn && nn.trim()) {
        const clean = nn.trim();
        const o = document.createElement("option");
        o.value = clean;
        o.textContent = clean;
        auditorSelect.insertBefore(o, auditorSelect.lastElementChild);
        auditorSelect.value = clean;
        setAuditor(clean);
      } else {
        auditorSelect.value = localStorage.getItem("auditorName") || "";
      }
    } else {
      setAuditor(v);
    }
  });
}

// --------------------------------------------------
// TABLE COLUMN HIDING (Expected Bin, Category, Subcategory)
// --------------------------------------------------
(function hideColumns() {
  const table = document.querySelector("table");
  if (!table) return;

  const headerCells = [...table.querySelectorAll("thead th")];
  const hideLabels = ["expected bin", "category", "subcategory"];

  const hideIdx = new Set();
  headerCells.forEach((th, idx) => {
    const label = String(th.textContent || "").trim().toLowerCase();
    if (hideLabels.includes(label)) {
      hideIdx.add(idx);
      th.style.display = "none";
    }
  });

  if (!hideIdx.size) return;

  table.querySelectorAll("tbody tr").forEach(tr => {
    [...tr.children].forEach((td, idx) => {
      if (hideIdx.has(idx)) td.style.display = "none";
    });
  });
})();

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
// CAMERA PERMISSION PREFLIGHT
// --------------------------------------------------
(async () => {
  try {
    if (!navigator.permissions || !navigator.mediaDevices) return;
    const status = await navigator.permissions.query({ name: "camera" });
    if (status.state === "prompt") {
      // Trigger one lightweight request; user can deny/allow
      await navigator.mediaDevices.getUserMedia({ video: true });
    }
  } catch {
    // Ignore; we’ll request again when scanning actually starts
  }
})();

// --------------------------------------------------
// OVERLAY UI HELPERS
// --------------------------------------------------
let activeStream = null;

function stopAnyOpenScanner() {
  try {
    if (activeStream) {
      activeStream.getTracks().forEach(t => t.stop());
    }
  } catch {}
  activeStream = null;
  document.querySelectorAll(".shappi-scan-overlay").forEach(el => el.remove());
}

function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
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

// --------------------------------------------------
// BIN SCAN (3-letter + server validation)
// --------------------------------------------------
if (scanBinBtn) scanBinBtn.onclick = () => startQRScan();

async function startQRScan() {
  const { overlay, video, stopBtn, title } = createOverlay();
  title.textContent = "Scan Bin QR";

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    stopAnyOpenScanner();
    overlay.remove();
    toast("Stopped bin scanning", "info");
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
      if (stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        if (code && code.data) {
          const raw = code.data.trim().toUpperCase();

          // Client-side format check: exactly 3 letters
          if (!/^[A-Z]{3}$/.test(raw)) {
            flashOK(); // still flash to show we *saw* something
            toast("Invalid bin format (must be 3 letters)", "error");
            stopped = true;
            stopAnyOpenScanner();
            overlay.remove();
            return;
          }

          // Ask server to start audit + validate bin exists in CSV
          try {
            const auditor = localStorage.getItem("auditorName") || "Unknown";
            const res = await fetch(
              `/audit/start/${encodeURIComponent(raw)}?auditor=${encodeURIComponent(auditor)}`,
              { method: "POST" }
            );

            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              toast(err.error || "Invalid bin", "error");
              stopped = true;
              stopAnyOpenScanner();
              overlay.remove();
              return;
            }

            currentBin = raw;
            if (currentBinEl) currentBinEl.textContent = raw;

            flashOK();
            toast(`Bin set: ${raw}`, "success");
            stopped = true;
            stopAnyOpenScanner();
            overlay.remove();

            // Immediately start item scanning
            startContinuousItemScan();
            return;
          } catch (err) {
            console.error("Bin validation error", err);
            toast("Bin validation failed", "error");
            stopped = true;
            stopAnyOpenScanner();
            overlay.remove();
            return;
          }
        }
      }

      requestAnimationFrame(loop);
    };

    loop();
  } catch (err) {
    console.error("Camera error (bin)", err);
    toast("Camera access denied or unavailable", "error");
    stopAnyOpenScanner();
    overlay.remove();
  }
}

// --------------------------------------------------
// END BIN AUDIT BUTTON
// --------------------------------------------------
if (endBinBtn) {
  endBinBtn.onclick = async () => {
    if (!currentBin) {
      toast("No active bin. Scan a Bin QR first.", "warn");
      return;
    }
    try {
      await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, { method: "POST" });
      toast(`Audit ended for ${currentBin}`, "info");
    } catch (err) {
      console.error("End audit error", err);
      toast("Failed to end audit", "error");
    } finally {
      currentBin = null;
      if (currentBinEl) currentBinEl.textContent = "None";
      stopAnyOpenScanner();
    }
  };
}

// --------------------------------------------------
// ITEM SCANNING (debounced + fixed QR detection)
// --------------------------------------------------
let lastScanTime = 0;
const COOLDOWN = 900; // ms between distinct reads

if (scanItemBtn) scanItemBtn.onclick = () => startContinuousItemScan();

async function startContinuousItemScan() {
  if (!currentBin) {
    toast("Scan a Bin QR first.", "warn");
    return;
  }
  if (scanning) return;

  scanning = true;

  const { overlay, video, stopBtn, title } = createOverlay();
  title.textContent = `Scanning Items • Bin ${currentBin}`;

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    scanning = false;
    stopAnyOpenScanner();
    overlay.remove();
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

    const tick = async () => {
      if (stopped || !scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        const now = Date.now();

        if (code && code.data && now - lastScanTime > COOLDOWN) {
          lastScanTime = now;
          flashOK();
          await handleItemScan(code.data.trim());
        }
      }

      requestAnimationFrame(tick);
    };

    tick();
  } catch (err) {
    console.error("Camera error (items)", err);
    scanning = false;
    toast("Camera error", "error");
    overlay.remove();
  }
}

// --------------------------------------------------
// HANDLE ITEM SCAN (unique per bin + update row)
// --------------------------------------------------
async function handleItemScan(itemId) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  try {
    const res = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || "Scan failed", "error");
      return;
    }

    const data = await res.json();
    const rec  = data.record || {};

    // Map statuses -> UI
    let label = "";
    let cls   = "";

    switch (data.status) {
      case "match":
        label = "Correct Bin";
        cls   = "green";
        toast(`✓ ${itemId} in correct bin`, "success");
        break;

      case "mismatch":
        label = `Move → ${data.correctBin || "Unknown"}`;
        cls   = "yellow";
        toast(`Move ${itemId} to ${data.correctBin}`, "warn");
        break;

      case "no-bin":
        label = "Not in CSV";
        cls   = "red";
        toast(`🚫 ${itemId} not in CSV`, "error");
        break;

      case "remove-item":
        label = "Remove Item";
        cls   = "red";
        toast(`🗑️ Remove ${itemId} from bin`, "error");
        break;

      default:
        label = data.status || "Unknown";
        cls   = "grey";
        toast(label, "info");
    }

    if (!logTbody) return;

    // Ensure one row per item per bin: update if exists
    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    const columnsHtml = `
      <td>${itemId}</td>
      <td style="display:none"></td>       <!-- Expected Bin (hidden) -->
      <td>${currentBin}</td>
      <td>${rec.received    || "-"}</td>
      <td>${rec.statusText  || "-"}</td>
      <td style="display:none"></td>       <!-- Category (hidden) -->
      <td style="display:none"></td>       <!-- Subcategory (hidden) -->
      <td class="status-col">
        <span class="status-pill ${cls}">${label}</span>
      </td>
      <td>
        ${
          data.status === "mismatch"
            ? `<label style="cursor:pointer;">
                 <input type="checkbox"
                        class="resolveToggle"
                        data-bin="${currentBin}"
                        data-item="${itemId}">
                 Mark Moved
               </label>`
            : "-"
        }
      </td>
    `;

    if (row) {
      row.innerHTML = columnsHtml;
    } else {
      row = document.createElement("tr");
      row.dataset.item = itemId;
      row.innerHTML = columnsHtml;
      logTbody.prepend(row);
    }
  } catch (err) {
    console.error("Scan error", err);
    toast("Scan error", "error");
  }
}

// --------------------------------------------------
// RESOLUTION CHECKBOX HANDLER
// --------------------------------------------------
if (logTbody) {
  logTbody.addEventListener("change", async (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.classList.contains("resolveToggle")) return;

    const binId    = el.getAttribute("data-bin");
    const itemId   = el.getAttribute("data-item");
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
  if (!logTbody) return;
  const cb = logTbody.querySelector(
    `input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`
  );
  if (cb) cb.checked = !!resolved;
});

// --------------------------------------------------
// EXPORT VISIBLE ROWS
// --------------------------------------------------
const exportVisibleBtn = document.getElementById("exportVisible");
if (exportVisibleBtn && logTbody) {
  exportVisibleBtn.onclick = () => {
    let csv = "Item ID,Scanned Bin,WH Received,Shappi Status,Audit Status,Resolved\n";
    [...logTbody.children].forEach(row => {
      const cells = [...row.children].map(td => td.innerText.trim());
      // indexes: 0 = Item ID, 2 = Scanned Bin, 3 = WH, 4 = Shappi Status, 7 = Audit, 8 = Resolved
      csv += `${cells[0]},${cells[2]},${cells[3]},${cells[4]},${cells[7]},${cells[8]}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `shappi_visible_results_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

// --------------------------------------------------
// DOWNLOAD FULL AUDIT SUMMARY
// --------------------------------------------------
const fullAuditBtn = document.getElementById("downloadAuditCsv");
if (fullAuditBtn) {
  fullAuditBtn.onclick = () => {
    window.location.href = "/export-summary";
  };
}

// --------------------------------------------------
// TOAST + FLASH HELPERS
// --------------------------------------------------
function toast(msg, type = "info") {
  const toastEl = document.getElementById("toast");
  if (!toastEl) return;

  toastEl.textContent = msg;
  toastEl.style.display = "block";
  toastEl.style.background =
    type === "success" ? "#22c55e" :
    type === "warn"    ? "#eab308" :
    type === "error"   ? "#ef4444" : "#6c47ff";

  setTimeout(() => {
    toastEl.style.display = "none";
  }, 2000);
}

function flashOK() {
  const flash = document.createElement("div");
  flash.style = `
    position: fixed;
    inset: 0;
    background: rgba(34,197,94,0.28);
    z-index: 9998;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 180);
}

