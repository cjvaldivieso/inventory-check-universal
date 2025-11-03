const socket = io();

// === CSV Upload + Live Timestamp ===
const csvInfo = document.getElementById("csvInfo");
const csvTimestamp = document.getElementById("csvTimestamp");
const csvUpload = document.getElementById("csvUpload");

// Toast element (defined in index.html)
const toast = document.getElementById("toast");
function showToast(msg, color = "#6c47ff") {
  if (!toast) return;
  toast.textContent = msg;
  toast.style.background = color;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 2500);
}

// Socket event: when *anyone* uploads a CSV
socket.on("csvUpdated", (meta) => {
  if (csvInfo) csvInfo.textContent = `✅ ${meta.total} records loaded`;
  if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${meta.uploadedAt}`;
  showToast("✅ CSV uploaded and synced");
});

// Local upload: when *you* upload CSV
if (csvUpload) {
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/upload-csv", { method: "POST", body: fd });
      const data = await res.json();

      if (csvInfo) csvInfo.textContent = `✅ ${data.total} records loaded`;
      if (csvTimestamp) csvTimestamp.textContent = `Last Updated: ${data.uploadedAt}`;
      showToast("✅ CSV uploaded successfully");
    } catch (err) {
      console.error("CSV upload failed", err);
      showToast("❌ CSV upload failed", "#e63946");
    }
  });
}

// Load CSV status when page opens
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();
    if (d.uploadedAt && csvTimestamp)
      csvTimestamp.textContent = `Last Updated: ${d.uploadedAt}`;
    if (d.total && csvInfo)
      csvInfo.textContent = `✅ ${d.total} records loaded`;
  } catch (err) {
    console.error("Failed to load CSV status:", err);
  }
})();

// === Auditor Selector ===
const auditorSelect = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  auditorDisplay.innerHTML = `Current User: <span id="currentAuditor">${name}</span>`;
}

function loadAuditor() {
  const saved = localStorage.getItem("auditorName");
  if (saved) {
    let opt = Array.from(auditorSelect.options).find((o) => o.value === saved);
    if (!opt) {
      const newOpt = document.createElement("option");
      newOpt.value = saved;
      newOpt.textContent = saved;
      auditorSelect.insertBefore(newOpt, auditorSelect.lastElementChild);
    }
    auditorSelect.value = saved;
    setAuditor(saved);
  }
}

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

loadAuditor();

// === Audit & Scanning Logic ===
let currentBin = null;
const logTbody = document.getElementById("logTbody");

// Camera scan overlay
async function startQRScan(type) {
  console.log("Starting QR scan:", type);

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.85)";
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "9999";
  document.body.appendChild(overlay);

  const video = document.createElement("video");
  video.style.width = "92vw";
  video.style.maxWidth = "640px";
  video.style.borderRadius = "12px";
  overlay.appendChild(video);

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "🛑 Stop Scanning";
  stopBtn.style.marginTop = "16px";
  stopBtn.style.background = "#ff5555";
  stopBtn.style.color = "#fff";
  stopBtn.style.border = "none";
  stopBtn.style.padding = "10px 20px";
  stopBtn.style.borderRadius = "10px";
  stopBtn.style.fontWeight = "600";
  overlay.appendChild(stopBtn);

  let stopRequested = false;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  video.srcObject = stream;
  await video.play();

  stopBtn.onclick = () => {
    stopRequested = true;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {}
    overlay.remove();
  };

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const tick = async () => {
    if (stopRequested) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
      });

      if (code && code.data) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {}
        overlay.remove();
        handleScanResult(type, code.data.trim());
        return;
      }
    }
    requestAnimationFrame(tick);
  };

  tick();
}

async function handleScanResult(type, code) {
  const auditor = localStorage.getItem("auditorName") || "Unknown";

  if (type === "bin") {
    currentBin = code;
    document.getElementById("currentBin").textContent = code;
    await fetch(`/audit/start/${encodeURIComponent(code)}?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
    });
    showToast(`📦 Bin ${code} ready for scanning`);
  } else if (type === "item") {
    if (!currentBin) {
      alert("Scan a Bin QR first.");
      return;
    }
    handleItemScan(code, auditor);
  }
}

async function handleItemScan(itemId, auditor) {
  try {
    const r = await fetch(`/audit/scan?auditor=${encodeURIComponent(auditor)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binId: currentBin, itemId }),
    });
    const data = await r.json();

    const tr = document.createElement("tr");
    let label = "",
      cls = "";
    if (data.status === "match") {
      label = "✅ Correct Bin";
      cls = "green";
    } else if (data.status === "mismatch") {
      label = `⚠️ Wrong Bin → Move to ${data.correctBin || "Unknown"}`;
      cls = "yellow";
      showToast(`⚠️ Item ${itemId} belongs in ${data.correctBin}`, "#ffb703");
    } else if (data.status === "no-bin") {
      label = "🚫 No Bin (not in CSV)";
      cls = "red";
      showToast(`🚫 Item ${itemId} not in CSV`, "#e63946");
    }

    const expected = data.correctBin || "-";
    const rec = data.record || {};

    tr.innerHTML = `
      <td>${itemId}</td>
      <td>${expected}</td>
      <td>${currentBin || "-"}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td>${rec.category || "-"}</td>
      <td>${rec.subcategory || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>
        ${
          data.status === "mismatch"
            ? `<label style="cursor:pointer;">
                 <input type="checkbox" data-bin="${currentBin}" data-item="${itemId}" class="resolveToggle">
               </label>`
            : "-"
        }
      </td>
    `;
    logTbody.prepend(tr);
  } catch (err) {
    console.error(err);
    alert("Scan error.");
  }
}

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
  } catch (err) {
    console.error("Resolve update failed", err);
  }
});

socket.on("itemResolved", ({ binId, itemId, resolved }) => {
  const cb = logTbody.querySelector(
    `input.resolveToggle[data-bin="${binId}"][data-item="${itemId}"]`
  );
  if (cb) cb.checked = !!resolved;
});

// Buttons
document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
document.getElementById("scanItemBtn").onclick = () => startQRScan("item");
document.getElementById("endBinBtn").onclick = async () => {
  if (!currentBin) {
    alert("No active bin. Scan a Bin QR first.");
    return;
  }
  await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, { method: "POST" });
  showToast(`✅ Audit ended for Bin ${currentBin}`);
  currentBin = null;
  document.getElementById("currentBin").textContent = "None";
};

// Export on-screen results
document.getElementById("exportLogBtn").onclick = () => {
  const rows = [
    ["Item ID", "Expected Bin", "Scanned Bin", "WH Received", "Shappi Status", "Category", "Subcategory", "Audit Status", "Resolved"],
  ];
  logTbody.querySelectorAll("tr").forEach((tr) => {
    const cols = Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim());
    rows.push(cols);
  });
  const csv = rows.map((r) =>
    r.map((v) => {
      const s = (v ?? "").toString();
      return s.includes(",") || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "audit_results.csv";
  a.click();
};

// Export full server-side summary
document.getElementById("exportSummaryBtn").onclick = () => {
  window.location.href = "/export-summary";
};

