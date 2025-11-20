/* public/app.js – Shappi WH Inventory v4.1 (stable reset)
 * - CSV upload + live status via socket
 * - Auditor selector (localStorage)
 * - Bin scan with validation (3 letters + must exist)
 * - Continuous Item scan (deduped, debounced)
 * - Export visible table
 * - Export full audit CSV (summary + detail, extra cols)
 */

const socket = io();

// DOM refs
const csvUploadInput = document.getElementById("csvUpload");
const csvUploadBtn = document.getElementById("csvUploadBtn");
const csvInfo = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");

const auditorSelect = document.getElementById("auditorSelect");
const currentAuditorSpan = document.getElementById("currentAuditor");

const scanBinBtn = document.getElementById("scanBinBtn");
const scanItemBtn = document.getElementById("scanItemBtn");
const exportVisibleBtn = document.getElementById("exportVisible");
const exportSummaryBtn = document.getElementById("exportSummaryBtn");

const currentBinEl = document.getElementById("currentBin");
const logTbody = document.getElementById("logTbody");

// state
let currentBin = null;
let scanning = false;
let lastScanTime = 0;
const COOLDOWN = 900;
let activeStream = null;

// ----------------------------------------
// CSV live meta
// ----------------------------------------
socket.on("csvUpdated", (meta) => {
  if (!meta) return;
  csvInfo.textContent = `📦 CSV Loaded (${meta.total || 0})`;
  csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt || "(none)"}`;
});

// Initial status from server
(async () => {
  try {
    const r = await fetch("/csv-status");
    if (!r.ok) return;
    const meta = await r.json();
    if (meta && typeof meta.total !== "undefined") {
      csvInfo.textContent = `📦 CSV Loaded (${meta.total})`;
      csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt || "(none)"}`;
    }
  } catch (err) {
    console.error("csv-status error", err);
  }
})();

// Upload CSV button wrapper
if (csvUploadBtn && csvUploadInput) {
  csvUploadBtn.addEventListener("click", () => csvUploadInput.click());

  csvUploadInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/upload-csv", { method: "POST", body: fd });
      if (!res.ok) throw new Error("upload failed");
      const data = await res.json();
      csvInfo.textContent = `📦 CSV Loaded (${data.total})`;
      csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;
      toast(`CSV uploaded • ${data.total} items`, "success");

      // Reset UI state
      currentBin = null;
      currentBinEl.textContent = "None";
      logTbody.innerHTML = "";
    } catch (err) {
      console.error("CSV upload error", err);
      toast("CSV upload failed", "error");
    } finally {
      // allow choosing same file again
      csvUploadInput.value = "";
    }
  });
}

// ----------------------------------------
// Auditor selector
// ----------------------------------------
function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  currentAuditorSpan.textContent = name;
}

(function initAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    // ensure option exists
    if (![...auditorSelect.options].some((o) => o.value === saved)) {
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
      if (nn && nn.trim()) {
        const clean = nn.trim();
        const opt = document.createElement("option");
        opt.value = clean;
        opt.textContent = clean;
        auditorSelect.insertBefore(opt, auditorSelect.lastElementChild);
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

// ----------------------------------------
// Camera overlay helpers
// ----------------------------------------
function stopScanner() {
  try {
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
    }
  } catch {}
  activeStream = null;
  scanning = false;
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
}

function createOverlay(titleText) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const title = document.createElement("div");
  title.className = "overlay-title";
  title.textContent = titleText;
  overlay.appendChild(title);

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop-btn";
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.onclick = () => {
    toast("Stopped scanning", "info");
    stopScanner();
  };
  overlay.appendChild(stopBtn);

  document.body.appendChild(overlay);
  return { overlay, video };
}

// Small “green flash” when scan succeeds
function flashOK() {
  const d = document.createElement("div");
  d.style =
    "position:fixed;inset:0;background:rgba(34,197,94,0.2);z-index:9990;";
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 180);
}

// ----------------------------------------
// Bin scanning
// ----------------------------------------
if (scanBinBtn) {
  scanBinBtn.addEventListener("click", () => startBinScan());
}

async function startBinScan() {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  const { overlay, video } = createOverlay("Scan Bin");
  scanning = true;

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tick = async () => {
      if (!scanning || !activeStream) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height);

        if (code && code.data) {
          const raw = code.data.trim().toUpperCase();
          if (/^[A-Z]{3}$/.test(raw)) {
            // Validate bin with server
            try {
              const res = await fetch(
                `/audit/start/${encodeURIComponent(
                  raw
                )}?auditor=${encodeURIComponent(auditor)}`,
                { method: "POST" }
              );
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                if (err.error === "no-bin") {
                  toast("Unable to validate bin. Check CSV.", "error");
                } else if (err.error === "bad-format") {
                  toast("Bin must be 3 letters.", "error");
                } else if (err.error === "no-csv") {
                  toast("Upload CSV first.", "error");
                } else {
                  toast("Bin validation failed.", "error");
                }
              } else {
                flashOK();
                currentBin = raw;
                currentBinEl.textContent = raw;
                toast(`Bin set: ${raw}`, "success");
                stopScanner();
                // autostart item scan
                startItemScan();
                return;
              }
            } catch (e) {
              console.error("bin scan error", e);
              toast("Bin validation error", "error");
            }
          } else {
            toast("Bin QR must be 3 letters (e.g., ZXC).", "warn");
          }
        }
      }
      requestAnimationFrame(tick);
    };

    tick();
  } catch (err) {
    console.error("camera error", err);
    toast("Camera error", "error");
    stopScanner();
  }
}

// ----------------------------------------
// Item scanning (continuous)
// ----------------------------------------
if (scanItemBtn) {
  scanItemBtn.addEventListener("click", () => startItemScan());
}

async function startItemScan() {
  if (!currentBin) {
    toast("Scan a bin first.", "warn");
    return;
  }
  if (scanning) return;

  const { overlay, video } = createOverlay(`Scanning Items • Bin ${currentBin}`);
  scanning = true;

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    video.srcObject = activeStream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tick = async () => {
      if (!scanning || !activeStream) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height);
        const now = Date.now();

        if (code && code.data && now - lastScanTime > COOLDOWN) {
          lastScanTime = now;
          const itemId = code.data.trim();
          if (!itemId) {
            requestAnimationFrame(tick);
            return;
          }
          flashOK();
          await handleItemScan(itemId);
        }
      }
      requestAnimationFrame(tick);
    };

    tick();
  } catch (err) {
    console.error("camera error", err);
    toast("Camera error", "error");
    stopScanner();
  }
}

// ----------------------------------------
// Handle item scan result -> update table
// ----------------------------------------
async function handleItemScan(itemId) {
  try {
    const res = await fetch("/audit/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId }),
    });

    if (!res.ok) {
      toast("Scan failed", "error");
      return;
    }

    const data = await res.json();
    const rec = data.record || {};
    let auditLabel = "";
    let pillClass = "";

    if (data.status === "match") {
      auditLabel = "Correct Bin";
      pillClass = "status-green";
      toast(`✓ ${itemId} in correct bin`, "success");
    } else if (data.status === "mismatch") {
      auditLabel = `Move → ${rec.expectedBin || "?"}`;
      pillClass = "status-yellow";
      toast(`Move ${itemId} → ${rec.expectedBin || "?"}`, "warn");
    } else if (data.status === "remove-item") {
      auditLabel = "Remove Item";
      pillClass = "status-red";
      toast(`Remove ${itemId}`, "error");
    } else {
      auditLabel = "Not in CSV";
      pillClass = "status-red";
      toast(`${itemId} not in CSV`, "error");
    }

    const whReceived = rec.received || "-";
    const shappiStatus = rec.statusText || "-";

    // Update / insert row (unique per item)
    let row = logTbody.querySelector(`tr[data-item="${itemId}"]`);
    const cellsHtml = `
      <td>${itemId}</td>
      <td>${currentBin}</td>
      <td>${whReceived}</td>
      <td>${shappiStatus}</td>
      <td><span class="status-pill ${pillClass}">${auditLabel}</span></td>
      <td>
        ${
          data.status === "mismatch" || data.status === "remove-item"
            ? `<label><input type="checkbox"
                   class="resolveToggle"
                   data-bin="${currentBin}"
                   data-item="${itemId}"> Resolved</label>`
            : "-"
        }
      </td>
    `;

    if (row) {
      row.innerHTML = cellsHtml;
    } else {
      row = document.createElement("tr");
      row.dataset.item = itemId;
      row.innerHTML = cellsHtml;
      logTbody.prepend(row);
    }
  } catch (err) {
    console.error("handleItemScan error", err);
    toast("Scan error", "error");
  }
}

// ----------------------------------------
// Resolve checkbox
// ----------------------------------------
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
        body: JSON.stringify({ binId, itemId, resolved }),
      });
    } catch {
      toast("Failed to update resolve state", "error");
    }
  });
}

// ----------------------------------------
// Export visible table
// ----------------------------------------
if (exportVisibleBtn) {
  exportVisibleBtn.addEventListener("click", () => {
    let csv = "Item,Bin,WH Received,Status,Audit,Resolved\n";

    [...logTbody.children].forEach((row) => {
      const cells = [...row.children].map((td) =>
        (td.innerText || "").trim().replace(/,/g, " ")
      );
      csv += cells.join(",") + "\n";
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shappi_table_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ----------------------------------------
// Export full audit (server CSV)
// ----------------------------------------
if (exportSummaryBtn) {
  exportSummaryBtn.onclick = () => {
    window.location.href = "/export-full-audit";
  };
}

// ----------------------------------------
// Toast
// ----------------------------------------
function toast(msg, type = "info") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.style.display = "block";

  t.style.background =
    type === "success"
      ? "#22c55e"
      : type === "warn"
      ? "#eab308"
      : type === "error"
      ? "#dc2626"
      : "#6c47ff";

  // Hold longer so "Move XXX -> BIN" is readable
  setTimeout(() => {
    t.style.display = "none";
  }, 5000);
}

