/* Shappi WH Inventory App — v4.3
 * - CSV upload + shared live metadata
 * - Auditor selector (localStorage)
 * - Bin QR (3 letters + server validation)
 * - Item QR (iOS-safe scanner loop, no duplicates per bin)
 * - Hidden ExpectedBin / Category / Subcategory values
 * - Export visible rows + full audit CSV endpoint
 */

const socket = io();

// ------------------------------------------------------------
// CSV META
// ------------------------------------------------------------
const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// Anyone uploads CSV → all clients update
socket.on("csvUpdated", (meta) => {
  csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV updated — ${meta.total} items`, "info");
});

// Initial metadata
(async () => {
  try {
    const res = await fetch("/csv-status");
    const d = await res.json();
    if (typeof d.total !== "undefined") {
      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;
    }
  } catch (e) {
    console.warn("CSV status unavailable", e);
  }
})();


// ------------------------------------------------------------
// CSV UPLOAD
// ------------------------------------------------------------
csvUpload.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("file", file);

  try {
    const r = await fetch("/upload-csv", { method: "POST", body: fd });
    const data = await r.json();

    csvInfo.textContent      = `📦 CSV Loaded (${data.total})`;
    csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;
    toast("CSV uploaded successfully", "success");
  } catch (err) {
    console.error(err);
    toast("CSV upload failed", "error");
  }
});


// ------------------------------------------------------------
// AUDITOR SELECTOR
// ------------------------------------------------------------
const auditorSelect  = document.getElementById("auditorSelect");
const currentAuditorDisplay = document.getElementById("currentAuditor");

function setAuditor(name) {
  localStorage.setItem("auditorName", name);
  currentAuditorDisplay.textContent = name;
}

// Load auditor
(function initAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved && auditorSelect) {
    // Ensure option exists
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
auditorSelect.addEventListener("change", () => {
  const v = auditorSelect.value;
  if (v === "__add_new__") {
    const n = prompt("Enter new user name:");
    if (!n) {
      auditorSelect.value = localStorage.getItem("auditorName") || "";
      return;
    }
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
    auditorSelect.value = n;
    setAuditor(n);
  } else {
    setAuditor(v);
  }
});


// ------------------------------------------------------------
// BIN / ITEM SCAN DOM
// ------------------------------------------------------------
const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");

const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");
const endBinBtn    = document.getElementById("endBinBtn");

let currentBin = null;
let scanning = false;
let activeStream = null;


// ------------------------------------------------------------
// CAMERA PERMISSIONS (pre-request on iPhone)
// ------------------------------------------------------------
(async () => {
  try {
    if (!navigator.permissions) return;
    const r = await navigator.permissions.query({ name: "camera" });
    if (r.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ video: true });
    }
  } catch {}
})();


// ------------------------------------------------------------
// OVERLAY CREATOR
// ------------------------------------------------------------
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "scan-overlay";
  overlay.style = `
    position:fixed; inset:0;
    background:rgba(0,0,0,0.92);
    display:flex; flex-direction:column;
    align-items:center;
    padding-top:40px;
    z-index:9999;
  `;

  const title = document.createElement("div");
  title.style = `color:#fff; font-size:20px; font-weight:700; margin-bottom:14px;`;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.autoplay = true;
  video.muted = true;
  video.style = `width:92vw; max-width:650px; border-radius:14px;`;
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style = `
    margin-top:18px;
    padding:12px 22px;
    border:none;
    border-radius:12px;
    background:#ff5555;
    color:#fff;
    font-size:18px;
    font-weight:600;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn, title };
}

function stopScanner() {
  try {
    activeStream?.getTracks().forEach(t => t.stop());
  } catch {}
  activeStream = null;
  document.querySelectorAll(".scan-overlay").forEach(el => el.remove());
}


// ------------------------------------------------------------
// BIN SCANNING
// ------------------------------------------------------------
scanBinBtn.onclick = () => startBinScan();

async function startBinScan() {
  const { overlay, video, stopBtn, title } = createOverlay();
  title.textContent = "Scan Bin QR";

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; stopScanner(); };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }
    });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    async function loop() {
      if (stopped) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, canvas.width, canvas.height);

        if (code && code.data) {
          const bin = code.data.trim().toUpperCase();

          // Must be 3 letters
          if (!/^[A-Z]{3}$/.test(bin)) {
            toast("Invalid bin (must be 3 letters)", "error");
          } else {
            // Validate against CSV (server stored list)
            const r = await fetch(`/validate-bin/${bin}`);
            const v = await r.json();
            if (!v.valid) {
              toast("Bin not in CSV", "error");
            } else {
              currentBin = bin;
              currentBinEl.textContent = bin;
              toast(`Bin set: ${bin}`, "success");
              stopScanner();
              startContinuousItemScan();
              return;
            }
          }
        }
      }
      requestAnimationFrame(loop);
    }
    loop();

  } catch (err) {
    console.error(err);
    toast("Camera error", "error");
    overlay.remove();
  }
}


// ------------------------------------------------------------
// ITEM SCANNING — FULL PRODUCTION SAFE LOOP
// ------------------------------------------------------------
let lastItemScan = 0;
const ITEM_COOLDOWN = 900;

scanItemBtn.onclick = () => startContinuousItemScan();

async function startContinuousItemScan() {
  if (!currentBin) return toast("Scan a bin first", "warn");
  if (scanning) return;
  scanning = true;

  const { overlay, video, stopBtn, title } = createOverlay();
  title.textContent = `Scanning Items • Bin ${currentBin}`;

  let stopped = false;
  stopBtn.onclick = () => {
    stopped = true;
    scanning = false;
    stopScanner();
    toast("Stopped scanning", "info");
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    async function scanLoop() {
      if (stopped || !scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, canvas.width, canvas.height);

        const now = Date.now();
        if (code && code.data && now - lastItemScan > ITEM_COOLDOWN) {
          lastItemScan = now;
          flashOK();
          await handleItemScan(code.data.trim());
        }
      }

      requestAnimationFrame(scanLoop);
    }

    scanLoop();

  } catch (err) {
    scanning = false;
    console.error("Item scan error:", err);
    toast("Camera error", "error");
  }
}


// ------------------------------------------------------------
// HANDLE ITEM SCAN
// ------------------------------------------------------------
async function handleItemScan(itemId) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  try {
    const r = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId })
    });
    const data = await r.json();
    const rec = data.record || {};

    let label = "";
    let cls = "";

    if (data.status === "match") {
      label = "Correct Bin"; cls = "green";
      toast(`✓ ${itemId} correct`, "success");
    } else if (data.status === "mismatch") {
      label = `Move → ${data.correctBin}`; cls = "yellow";
      toast(`Move ${itemId} → ${data.correctBin}`, "warn");
    } else if (data.status === "remove-item") {
      label = "Remove Item"; cls = "red";
      toast(`🗑️ Remove ${itemId}`, "error");
    } else if (data.status === "no-bin") {
      label = "Not in CSV"; cls = "red";
      toast(`🚫 ${itemId} not in CSV`, "error");
    } else {
      label = "Unknown"; cls = "grey";
    }

    // Update existing row (prevent duplicates)
    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

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
          ? `<label><input type="checkbox" class="resolveToggle" data-item="${itemId}" data-bin="${currentBin}"> Move</label>`
          : "-"
      }</td>
    `;

    if (row) row.innerHTML = columns;
    else {
      const tr = document.createElement("tr");
      tr.dataset.item = itemId;
      tr.innerHTML = columns;
      logTbody.prepend(tr);
    }

  } catch (e) {
    console.error(e);
    toast("Scan error", "error");
  }
}


// ------------------------------------------------------------
// MOVE RESOLUTION
// ------------------------------------------------------------
logTbody.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("resolveToggle")) return;

  const item = e.target.dataset.item;
  const bin  = e.target.dataset.bin;
  const resolved = e.target.checked;

  try {
    await fetch("/audit/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item, binId: bin, resolved })
    });
  } catch (err) {
    toast("Failed to update", "error");
  }
});


// ------------------------------------------------------------
// EXPORT (visible only)
// ------------------------------------------------------------
document.getElementById("exportVisible").onclick = () => {
  let csv = "Item ID,Scanned Bin,WH Received,Status,Audit Status,Resolved\n";

  [...logTbody.children].forEach(row => {
    const c = [...row.children].map(td => td.innerText.trim());
    csv += `${c[0]},${c[2]},${c[3]},${c[4]},${c[7]},${c[8]}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `visible_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};


// ------------------------------------------------------------
// FULL AUDIT SUMMARY
// ------------------------------------------------------------
document.getElementById("downloadAuditCsv").onclick = () => {
  window.location.href = "/export-summary";
};


// ------------------------------------------------------------
// VISUAL FLASH ON SUCCESS
// ------------------------------------------------------------
function flashOK() {
  const div = document.createElement("div");
  div.style = `
    position:fixed; inset:0;
    background:rgba(40,167,69,0.30);
    z-index:9998;
  `;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 150);
}


// ------------------------------------------------------------
// TOAST
// ------------------------------------------------------------
function toast(msg, type="info") {
  const t = document.getElementById("toast");
  t.textContent = msg;

  t.style.display = "block";
  t.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => { t.style.display = "none"; }, 1800);
}

