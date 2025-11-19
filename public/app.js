/* public/app.js — Shappi Inventory App v4.1 */

/* FEATURES:
 - CSV upload (iOS + Chrome compatible)
 - Bin validation: 3 letters + must exist in CSV
 - Duplicate scan prevention (900ms)
 - Update existing row instead of adding duplicates
 - Hide category & subcategory
 - Stable scanning loop (iPhone safe)
 - Works for all users (timestamps included)
 - Export visible CSV + full audit CSV
*/

const socket = io();

// --------------------------------------------------
// DOM REFERENCES
// --------------------------------------------------
const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");

// CHROME DESKTOP SAFE — trigger hidden file input
const triggerCsvUpload = document.getElementById("triggerCsvUpload");
if (triggerCsvUpload && csvUpload) {
  triggerCsvUpload.addEventListener("click", () => {
    csvUpload.click();   // programmatically opens file chooser
  });
}

const auditorSelect  = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");
const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");
const endBinBtn    = document.getElementById("endBinBtn");

let currentBin = null;
let scanning   = false;
let lastScan   = 0;
const SCAN_COOLDOWN = 900; // ms

// --------------------------------------------------
// SOCKET: CSV STATUS UPDATES
// --------------------------------------------------
socket.on("csvUpdated", meta => {
  csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV updated • ${meta.total} items`, "info");
});

// load CSV meta on page load
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();
    if (d && typeof d.total !== "undefined") {
      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;
    }
  } catch (e) {
    console.error("csv-status error", e);
  }
})();

// --------------------------------------------------
// CSV UPLOAD (iOS + Chrome compatible)
// --------------------------------------------------
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
      toast(`CSV uploaded • ${data.total} items`, "success");
    } catch (err) {
      console.error("CSV upload failed", err);
      toast("CSV upload failed", "error");
    }
  });
}

// --------------------------------------------------
// AUDITOR SELECT
// --------------------------------------------------
function setAuditor(name) {
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = `Current User: ${name}`;
}

(function loadAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    if (![...auditorSelect.options].some(o => o.value === saved)) {
      const o = document.createElement("option");
      o.value = saved;
      o.textContent = saved;
      auditorSelect.insertBefore(o, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  }
})();

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

// --------------------------------------------------
// OVERLAY + CAMERA
// --------------------------------------------------
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-scan-overlay";
  overlay.style = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.92);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding-top: 40px; padding-bottom: 80px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan Bin";
  title.style = `
    color: #fff; font-weight: 700;
    margin-bottom: 16px; font-size: 20px;
  `;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style = `width: 92vw; max-width: 650px; border-radius: 14px;`;
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style = `
    margin-top: 20px; background:#ff5555;
    color:#fff; border:none; padding:12px 22px;
    border-radius:12px; font-weight:600; font-size:18px;
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
scanBinBtn.onclick = () => startQRScan();

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
          const bin = code.data.trim().toUpperCase();

          // ❗ BIN VALIDATION
          if (!/^[A-Z]{3}$/.test(bin)) {
            toast("Invalid bin — must be 3 letters", "error");
            flashOK("red");
            return;
          }

          // Check that bin exists in CSV
          const meta = await (await fetch("/csv-status")).json();
          if (!meta.bins.includes(bin)) {
            toast(`Invalid bin — not in CSV (${bin})`, "error");
            flashOK("red");
            return;
          }

          flashOK();
          currentBin = bin;
          currentBinEl.textContent = currentBin;

          overlay.remove();
          stopAnyOpenScanner();

          const auditor = localStorage.getItem("auditorName") || "Unknown";
          await fetch(`/audit/start/${bin}?auditor=${encodeURIComponent(auditor)}`, {
            method: "POST"
          });

          toast(`Bin set: ${bin}`, "success");
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
// ITEM SCANNING
// --------------------------------------------------
scanItemBtn.onclick = () => startContinuousItemScan();

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
    console.error(err);
    scanning = false;
    toast("Camera error", "error");
  }
}

// --------------------------------------------------
// HANDLE ITEM SCAN (UPDATE EXISTING ROWS)
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

    switch (data.status) {
      case "match":       label = "Correct Bin"; cls = "green";  break;
      case "mismatch":    label = `Move → ${data.correctBin}`; cls = "yellow"; break;
      case "no-bin":      label = "Not in CSV"; cls = "red"; break;
      case "remove-item": label = "Remove Item"; cls = "red"; break;
      default:            label = data.status || "Unknown"; cls = "grey";
    }

    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

    const html = `
      <td>${itemId}</td>
      <td style="display:none"></td>
      <td>${currentBin}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td style="display:none"></td>
      <td style="display:none"></td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>${data.status === "mismatch"
        ? `<label><input type="checkbox"
             class="resolveToggle"
             data-bin="${currentBin}"
             data-item="${itemId}"> Move</label>`
        : "-"}</td>
    `;

    if (row) {
      row.innerHTML = html;
    } else {
      row = document.createElement("tr");
      row.dataset.item = itemId;
      row.innerHTML = html;
      logTbody.prepend(row);
    }

  } catch (err) {
    console.error("Scan error", err);
    toast("Scan failed", "error");
  }
}

// --------------------------------------------------
// RESOLVE TOGGLE
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
    toast("Failed to update resolve state", "error");
  }
});

// --------------------------------------------------
// EXPORT VISIBLE ROWS
// --------------------------------------------------
document.getElementById("exportVisible").onclick = () => {
  let csv = "Item ID,Scanned Bin,WH Received,Shappi Status,Audit Status,Resolved\n";
  [...logTbody.children].forEach(row => {
    const c = [...row.children].map(td => td.innerText.trim());
    csv += `${c[0]},${c[2]},${c[3]},${c[4]},${c[7]},${c[8]}\n`;
  });

  const blob = new Blob([csv], { type:"text/csv" });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href = url;
  a.download = `shappi_visible_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// --------------------------------------------------
// EXPORT FULL AUDIT CSV
// --------------------------------------------------
document.getElementById("downloadAuditCsv").onclick = () => {
  window.location.href = "/export-summary";
};

// --------------------------------------------------
// FLASH
// --------------------------------------------------
function flashOK(color="green") {
  const flash = document.createElement("div");
  flash.style = `
    position: fixed; inset: 0;
    background: rgba(${color==="green"?"40,167,69":"220,53,69"},0.28);
    z-index: 9998;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 180);
}

// --------------------------------------------------
// TOAST
// --------------------------------------------------
function toast(msg, type="info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  t.style.background =
    type==="success" ? "#28a745" :
    type==="warn"    ? "#ffc107" :
    type==="error"   ? "#dc3545" : "#6c47ff";

  setTimeout(() => { t.style.display = "none"; }, 2000);
}

