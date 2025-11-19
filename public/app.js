/* public/app.js — Shappi Inventory App (v4.0) */
/* Includes:
 - Chrome-safe Upload CSV trigger
 - Bin validation (AAA format + must exist in CSV)
 - Duplicate scan prevention
 - Update-in-place rows
 - Hide category/subcategory
 - Improved UI table
 - CSV timestamp fixes
*/

const socket = io();

const csvInfo      = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload    = document.getElementById("csvUpload");
const triggerCsvUpload = document.getElementById("triggerCsvUpload");

// Trigger hidden input safely (Chrome Desktop compatible)
if (triggerCsvUpload && csvUpload) {
  triggerCsvUpload.addEventListener("click", () => {
    csvUpload.click();
  });
}

// Live CSV updates
socket.on("csvUpdated", (meta) => {
  csvInfo.textContent      = `📦 CSV Loaded (${meta.total})`;
  csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  toast(`CSV loaded — ${meta.total} items`, "success");
});

// Poll CSV on load
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();

    if (typeof d.total !== "undefined") {
      csvInfo.textContent      = `📦 CSV Loaded (${d.total})`;
      csvTimestamp.textContent = `Last Updated: ${d.uploadedAt || "(none)"}`;
    }
  } catch {}
})();

// Upload CSV
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
    toast("CSV uploaded successfully", "success");

  } catch (err) {
    toast("CSV upload failed", "error");
  }
});

/* AUDITOR SELECTOR */

const auditorSelect  = document.getElementById("auditorSelect");
const currentAuditorDisplay = document.getElementById("currentAuditorDisplay");

function setAuditor(name) {
  localStorage.setItem("auditorName", name);
  currentAuditorDisplay.textContent = `Current User: ${name}`;
}

(function loadAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    if (![...auditorSelect.options].some(o => o.value === saved)) {
      const opt = document.createElement("option");
      opt.value = saved; opt.textContent = saved;
      auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  }
})();

auditorSelect.addEventListener("change", () => {
  const v = auditorSelect.value;

  if (v === "__add_new__") {
    const nn = prompt("Enter your name:");
    if (nn) {
      const o = document.createElement("option");
      o.value = nn; o.textContent = nn;
      auditorSelect.insertBefore(o, auditorSelect.lastElementChild);
      auditorSelect.value = nn;
      setAuditor(nn);
    }
  } else {
    setAuditor(v);
  }
});

/* DOM REFS */

const currentBinEl = document.getElementById("currentBin");
const logTbody     = document.getElementById("logTbody");
const scanBinBtn   = document.getElementById("scanBinBtn");
const scanItemBtn  = document.getElementById("scanItemBtn");
const endBinBtn    = document.getElementById("endBinBtn");

let currentBin = null;
let scanning = false;
let binList = [];   // Comes from CSV Data
let lastScan = 0;
const SCAN_COOLDOWN = 1000;

/* CAMERA OVERLAY */

function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "shappi-overlay";
  overlay.style = `
    position: fixed; inset: 0; 
    background: rgba(0,0,0,.92);
    display: flex; flex-direction: column;
    align-items: center; padding-top: 35px;
    z-index: 9999;
  `;

  const title = document.createElement("div");
  title.textContent = currentBin ? `Scanning Items • Bin ${currentBin}` : "Scan QR";
  title.style = "color:#fff;font-weight:700;margin-bottom:15px;font-size:20px;";
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.style = "width:92vw;max-width:650px;border-radius:12px;";
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop";
  stopBtn.style = `
    margin-top:18px;background:#ff5555;color:#fff;
    padding:12px 20px;font-weight:700;border-radius:12px;
  `;
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video, stopBtn };
}

function stopScan() {
  try { activeStream?.getTracks().forEach(t => t.stop()); } catch {}
  activeStream = null;
  document.querySelectorAll(".shappi-overlay").forEach(el => el.remove());
}

/* BIN SCANNER */

let activeStream = null;

scanBinBtn.onclick = () => startBinScan();

async function startBinScan() {
  const { overlay, video, stopBtn } = createOverlay();

  stopBtn.onclick = stopScan;

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:"environment" } });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const loop = async () => {
      if (!activeStream) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        if (code && code.data) {
          const bin = code.data.trim().toUpperCase();

          if (!/^[A-Z]{3}$/.test(bin)) {
            toast("Invalid bin (must be AAA format)", "error");
            return;
          }

          if (!binList.includes(bin)) {
            toast("Bin not found in CSV", "error");
            return;
          }

          flashOK();
          currentBin = bin;
          currentBinEl.textContent = bin;

          stopScan();

          const auditor = localStorage.getItem("auditorName") || "Unknown";
          await fetch(`/audit/start/${bin}?auditor=${encodeURIComponent(auditor)}`, {
            method: "POST"
          });

          toast(`Bin set: ${bin}`, "success");
          startItemScan();
          return;
        }
      }

      requestAnimationFrame(loop);
    };

    loop();

  } catch (err) {
    toast("Camera error", "error");
    stopScan();
  }
}

/* ITEM SCAN */

scanItemBtn.onclick = () => startItemScan();

async function startItemScan() {
  if (!currentBin) return toast("Scan a bin first.", "warn");
  if (scanning) return;

  scanning = true;

  const { overlay, video, stopBtn } = createOverlay();

  stopBtn.onclick = () => {
    scanning = false;
    stopScan();
    toast("Stopped scanning", "info");
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:"environment" } });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const loop = async () => {
      if (!scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code  = jsQR(frame.data, frame.width, frame.height);

        const now = Date.now();

        if (code && code.data && now - lastScan > SCAN_COOLDOWN) {
          lastScan = now;
          flashOK();
          await handleItem(code.data.trim());
        }
      }

      requestAnimationFrame(loop);
    };

    loop();

  } catch {
    scanning = false;
    toast("Camera failed", "error");
    stopScan();
  }
}

/* HANDLE ITEM */

async function handleItem(itemId) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  const res = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ binId: currentBin, itemId })
  });

  const data = await res.json();
  const rec = data.record || {};

  let label = "";
  let cls = "";

  if (data.status === "match") {
    label = "Correct"; cls = "green";
  } else if (data.status === "mismatch") {
    label = `Move → ${data.correctBin}`; cls = "yellow";
  } else if (data.status === "no-bin") {
    label = "Not in CSV"; cls = "red";
  } else if (data.status === "remove-item") {
    label = "Remove Item"; cls = "red";
  } else {
    label = "Unknown"; cls = "grey";
  }

  let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);

  const html = `
    <td>${itemId}</td>
    <td>${rec.expectedBin || "-"}</td>
    <td>${currentBin}</td>
    <td>${rec.received || "-"}</td>
    <td>${rec.statusText || "-"}</td>
    <td><span class="status-pill ${cls}">${label}</span></td>
    <td>${data.status === "mismatch"
      ? `<input type="checkbox" class="resolveToggle" data-bin="${currentBin}" data-item="${itemId}">`
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
}

/* RESOLUTION CHECKBOX */

logTbody.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("resolveToggle")) return;

  const binId = e.target.dataset.bin;
  const itemId = e.target.dataset.item;
  const resolved = e.target.checked;

  await fetch("/audit/resolve", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ binId, itemId, resolved })
  });
});

/* EXPORT VISIBLE */

document.getElementById("exportVisible").onclick = () => {
  let csv = "Item ID,Expected Bin,Scanned Bin,WH Received,Status,Audit Status,Resolved\n";

  [...logTbody.children].forEach(row => {
    const c = [...row.children].map(td => td.innerText.trim());
    csv += `${c.join(",")}\n`;
  });

  const blob = new Blob([csv], { type:"text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `shappi_visible_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

/* EXPORT FULL AUDIT */
document.getElementById("downloadAuditCsv").onclick = () => {
  window.location.href = "/export-summary";
};

/* UI */

function flashOK() {
  const flash = document.createElement("div");
  flash.style = `
    position: fixed; inset: 0; background: rgba(40,167,69,.28);
    z-index: 9998;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 180);
}

function toast(msg, type="info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  t.style.background =
    type === "success" ? "#28a745" :
    type === "warn"    ? "#ffc107" :
    type === "error"   ? "#dc3545" : "#6c47ff";
  setTimeout(() => t.style.display = "none", 2500);
}

