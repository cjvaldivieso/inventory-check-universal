/* public/app.js — Shappi Inventory App (v18 final, FIXED)
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
  return { overlay, video, stopBtn };
}

function stopScanner() {
  try { activeStream?.getTracks()?.forEach(t => t.stop()); } catch(e){}
  activeStream = null;
  scanning     = false;
  document.querySelectorAll(".shappi-scan-overlay")?.forEach(o => o.remove());
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

  const { overlay, video, stopBtn } = createOverlay("Scan Bin QR");
  let stopped = false;

  stopBtn.onclick = () => { stopped = true; stopScanner(); };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });

    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");

    const loop = async () => {
      if (stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        if (code && code.data) {
          const bin = code.data.trim().toUpperCase();

          // 1) Pattern check
          if (!isValidBin(bin)) {
            toast("Invalid Bin — must be 3 letters (AAA)", "error");
            return; // keep loop running to scan again
          }

          // 2) Existence check in CSV (server-side)
          try {
            const resp  = await fetch(`/validate-bin/${encodeURIComponent(bin)}`);
            const info  = await resp.json();
            if (!info.valid) {
              toast("Bin not found in CSV", "error");
              return;
            }
          } catch (e) {
            console.error("Bin validation failed", e);
            toast("Unable to validate bin (check CSV)", "error");
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

  const { overlay, video, stopBtn } = createOverlay(`Scanning Items • Bin ${currentBin}`);
  let stopped = false;

  stopBtn.onclick = () => {
    stopped = true;
    stopScanner();
    toast("Stopped", "info");
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });

    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");

    const loop = async () => {
      if (!scanning || stopped) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        const now = Date.now();
        if (code && code.data && now - lastScan > SCAN_COOLDOWN) {
          lastScan = now;
          const id = code.data.trim();
          flashOK();
          await handleItemScan(id);
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
      toast(`❌ Remove ${itemId}`, "error");
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
    // c[0]=Item, c[1]=ExpectedBin(hidden), c[2]=Bin, c[3]=WH, c[4]=Status, c[5]=Audit, c[6]=Resolved
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
function toast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";

  t.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => { t.style.display = "none"; }, 2000);
}

