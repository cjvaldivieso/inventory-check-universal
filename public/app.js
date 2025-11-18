/* ======================================================
   SHAPPI INVENTORY APP — FRONTEND (v4.0)
   Matches server.js v4.0
   - Fixed Bin QR
   - CSV timestamp fix
   - Dedupe scan (client)
   - Update existing rows only once
   - Hide Category/Subcategory
   - Mobile layout fixes
   - “Invalid Bin” detection
====================================================== */

/* -------------------------
   GLOBALS
------------------------- */
const socket        = io();
const csvInfo       = document.getElementById("csvInfo");
const csvTimestamp  = document.getElementById("csvTimestamp");
const csvUpload     = document.getElementById("csvUpload");
const currentBinEl  = document.getElementById("currentBin");
const logTbody      = document.getElementById("logTbody");

const scanBinBtn    = document.getElementById("scanBinBtn");
const scanItemBtn   = document.getElementById("scanItemBtn");
const endBinBtn     = document.getElementById("endBinBtn");

const exportVisibleBtn  = document.getElementById("exportVisible");
const downloadAuditBtn  = document.getElementById("downloadAuditCsv");

let currentBin = null;
let scanning   = false;
let lastScanTs = 0;
const SCAN_COOLDOWN = 900;   // prevents duplicate scans (client-side delay)


/* -------------------------
   SOCKET — CSV UPDATED
------------------------- */
socket.on("csvUpdated", (meta) => {
  csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  localStorage.setItem("validBins", JSON.stringify(meta.bins || []));
  toast("CSV updated", "info");
});


/* -------------------------
   ON PAGE LOAD — Poll server
------------------------- */
(async () => {
  try {
    const res = await fetch("/csv-status");
    const d = await res.json();
    csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
    csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;
    localStorage.setItem("validBins", JSON.stringify(d.bins || []));
  } catch (err) {
    console.error("csv-status error:", err);
  }
})();


/* -------------------------
   CSV UPLOAD HANDLER
------------------------- */
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
      csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;

      localStorage.setItem("validBins", JSON.stringify(data.bins || []));
      toast("CSV uploaded!", "success");

    } catch (err) {
      console.error("CSV upload error", err);
      toast("CSV Upload Failed", "error");
    }
  });
}


/* -------------------------
   AUDITOR SELECTOR
------------------------- */
const auditorSelect  = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = `Current User: ${name}`;
}

(function loadAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved && auditorSelect) {
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
      const name = prompt("Enter new user name:");
      if (name) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
        auditorSelect.value = name;
        setAuditor(name);
      }
      return;
    }
    setAuditor(v);
  });
}


/* -------------------------
   BIN SCAN (FIXED)
------------------------- */
if (scanBinBtn) scanBinBtn.onclick = () => startBinScan();

async function startBinScan() {
  const { overlay, video, stopBtn } = createScanOverlay("Scan Bin QR");

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; stopScanner(); };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    window._scanStream = stream;
    video.srcObject = stream;
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
        const qr = jsQR(frame.data, frame.width, frame.height);

        if (qr && qr.data) {
          const scanned = qr.data.trim().toUpperCase();

          // ❗ MUST be exactly 3 letters
          if (!/^[A-Z]{3}$/.test(scanned)) {
            toast("❌ Invalid Bin Format (must be 3 letters)", "error");
            return;
          }

          const validBins = JSON.parse(localStorage.getItem("validBins") || "[]");

          if (!validBins.includes(scanned)) {
            toast("❌ Bin not in CSV", "error");
            return;
          }

          stopScanner();
          overlay.remove();
          flashOK();

          currentBin = scanned;
          currentBinEl.textContent = scanned;

          const auditor = localStorage.getItem("auditorName") || "Unknown";
          await fetch(`/audit/start/${scanned}?auditor=${encodeURIComponent(auditor)}`, {
            method: "POST"
          });

          toast(`Bin ${scanned} Started`, "success");
          startItemScan();
          return;
        }
      }

      requestAnimationFrame(loop);
    };
    loop();

  } catch (err) {
    console.error("Camera Error:", err);
    toast("Camera unavailable", "error");
    overlay.remove();
  }
}


/* -------------------------
   ITEM SCAN (with dedupe)
------------------------- */
if (scanItemBtn) scanItemBtn.onclick = () => startItemScan();

async function startItemScan() {
  if (!currentBin) return toast("Scan a Bin QR first.", "warn");
  if (scanning) return;

  scanning = true;
  const { overlay, video, stopBtn, title } = createScanOverlay(`Scanning • Bin ${currentBin}`);

  let stopped = false;
  stopBtn.onclick = () => { stopped = true; scanning = false; stopScanner(); toast("Stopped", "info"); };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    window._scanStream = stream;

    video.srcObject = stream;
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
        const qr = jsQR(frame.data, frame.width, frame.height);

        const now = Date.now();
        if (qr && qr.data && now - lastScanTs > SCAN_COOLDOWN) {
          lastScanTs = now;
          flashOK();
          await handleItemScan(qr.data.trim().toUpperCase());
        }
      }

      requestAnimationFrame(loop);
    };
    loop();

  } catch (err) {
    scanning = false;
    toast("Camera error", "error");
  }
}


/* -------------------------
   HANDLE ITEM SCAN
------------------------- */
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

    let label = "";
    let color = "";

    switch (data.status) {
      case "match":
        label = "Correct Bin"; color = "green";
        break;
      case "mismatch":
        label = `Move → ${data.correctBin}`; color = "yellow";
        break;
      case "no-bin":
        label = "Not in CSV"; color = "red";
        break;
      case "remove-item":
        label = "Remove Item"; color = "red";
        break;
      default:
        label = data.status; color = "grey";
    }

    // UPDATE OR INSERT ROW
    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    const rowHTML = `
      <td>${itemId}</td>
      <td style="display:none"></td>
      <td>${currentBin}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.status || "-"}</td>
      <td style="display:none"></td>
      <td style="display:none"></td>
      <td><span class="status-pill ${color}">${label}</span></td>
      <td>${
        data.status === "mismatch"
          ? `<input type="checkbox" class="resolveToggle" data-item="${itemId}" data-bin="${currentBin}">`
          : "-"
      }</td>
    `;

    if (row) {
      row.innerHTML = rowHTML;
    } else {
      row = document.createElement("tr");
      row.dataset.item = itemId;
      row.innerHTML = rowHTML;
      logTbody.prepend(row);
    }

  } catch (err) {
    console.error("Scan error:", err);
    toast("Scan failed", "error");
  }
}


/* -------------------------
   STOP CAMERA
------------------------- */
function stopScanner() {
  try {
    window._scanStream?.getTracks()?.forEach(t => t.stop());
  } catch {}
}


/* -------------------------
   OVERLAY BUILDER
------------------------- */
function createScanOverlay(titleText) {
  const overlay = document.createElement("div");
  overlay.className = "scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding-top: 40px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = titleText;
  title.style = `
    color: #fff;
    font-size: 20px;
    margin-bottom: 12px;
    font-weight: bold;
  `;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.style = `
    width: 92vw;
    max-width: 650px;
    border-radius: 12px;
  `;
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style = `
    margin-top: 18px;
    background: #ff5555;
    color: #fff;
    padding: 12px 24px;
    border-radius: 12px;
    border: none;
    font-size: 16px;
    font-weight: bold;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);

  return { overlay, video, stopBtn, title };
}


/* -------------------------
   END AUDIT
------------------------- */
if (endBinBtn) {
  endBinBtn.onclick = async () => {
    if (!currentBin) return toast("No active bin.", "warn");
    await fetch(`/audit/end/${currentBin}`, { method: "POST" });
    toast("Audit completed", "success");
    currentBin = null;
    currentBinEl.textContent = "None";
  };
}


/* -------------------------
   EXPORT VISIBLE ONLY
------------------------- */
if (exportVisibleBtn) {
  exportVisibleBtn.onclick = () => {
    let csv = "Item ID,Scanned Bin,Received,Status,Audit Status,Resolved\n";

    [...logTbody.children].forEach(row => {
      const c = [...row.children].map(td => td.innerText.trim());
      csv += `${c[0]},${c[2]},${c[3]},${c[4]},${c[7]},${c[8]}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `shappi_visible_${Date.now()}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  };
}


/* -------------------------
   EXPORT FULL AUDIT CSV
------------------------- */
if (downloadAuditBtn) {
  downloadAuditBtn.onclick = () => {
    window.location.href = "/export-summary";
  };
}


/* -------------------------
   TOAST / VISUALS
------------------------- */
function toast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";

  t.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => t.style.display = "none", 2000);
}

function flashOK() {
  const f = document.createElement("div");
  f.style = `
    position: fixed; inset: 0;
    background: rgba(50,205,50,0.35);
    z-index: 9998;
  `;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 180);
}

