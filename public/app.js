const socket = io();
let currentBin = null;
const logTbody = document.getElementById("logTbody");
const csvInfoEl = document.getElementById("csvInfo");
const auditorSelect = document.getElementById("auditorSelect");
const auditorDisplay = document.getElementById("currentAuditorDisplay");

// 🕓 Toast utility
function showToast(msg, color = "#6c47ff") {
  const toast = document.createElement("div");
  toast.textContent = msg;
  toast.style.position = "fixed";
  toast.style.bottom = "20px";
  toast.style.left = "50%";
  toast.style.transform = "translateX(-50%)";
  toast.style.background = color;
  toast.style.color = "#fff";
  toast.style.padding = "12px 20px";
  toast.style.borderRadius = "10px";
  toast.style.fontWeight = "600";
  toast.style.zIndex = "9999";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

// ===== Auditor Selector =====
function setAuditor(name) {
  if (!name) return;
  localStorage.setItem("auditorName", name);
  auditorDisplay.textContent = `Current User: ${name}`;
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

// ===== CSV Upload & Status =====
document.getElementById("csvUpload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/upload-csv", { method: "POST", body: fd });
  const data = await res.json();
  csvInfoEl.textContent = `📦 CSV Loaded (${data.total}) • Updated: ${data.timestamp}`;
  showToast("CSV uploaded successfully!", "#28a745");
});
socket.on("csvUpdated", (d) => {
  csvInfoEl.textContent = `📦 CSV Loaded (${d.total}) • Updated: ${d.timestamp}`;
});
(async () => {
  try {
    const r = await fetch("/csv-status");
    const d = await r.json();
    if (d.timestamp)
      csvInfoEl.textContent = `📦 CSV Loaded (${d.total}) • Updated: ${d.timestamp}`;
  } catch {}
})();

// ===== Start Bin Scan =====
document.getElementById("scanBinBtn").onclick = async () => {
  const binCode = await scanQR();
  if (binCode) {
    currentBin = binCode.trim();
    document.getElementById("currentBin").textContent = currentBin;
    await fetch(`/audit/start/${encodeURIComponent(currentBin)}`, { method: "POST" });
    showToast(`Bin set: ${currentBin}`, "#6c47ff");
  }
};

// ===== Continuous Item Scanning =====
document.getElementById("scanItemBtn").onclick = async () => {
  const auditor = localStorage.getItem("auditorName") || "Unknown";
  if (!currentBin) return alert("Scan a Bin QR first.");

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.9)";
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

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  video.srcObject = stream;
  await video.play();

  let stop = false;
  stopBtn.onclick = () => {
    stop = true;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {}
    overlay.remove();
  };

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let lastCode = "";

  const tick = async () => {
    if (stop) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });

      if (code && code.data && code.data !== lastCode) {
        lastCode = code.data;
        await handleItemScan(code.data.trim(), auditor);
        setTimeout(() => (lastCode = ""), 1500);
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
};

// ===== Handle Item Scan =====
async function handleItemScan(itemId, auditor) {
  try {
    const r = await fetch("/audit/scan?auditor=" + encodeURIComponent(auditor), {
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
      showToast(`✅ Item ${itemId} OK`, "#28a745");
    } else if (data.status === "mismatch") {
      label = `⚠️ Wrong Bin → Move to ${data.correctBin || "Unknown"}`;
      cls = "yellow";
      showToast(`⚠️ Move ${itemId} → ${data.correctBin}`, "#ffc107");
    } else if (data.status === "no-bin") {
      label = "🚫 No Bin (not in CSV)";
      cls = "red";
      showToast(`🚫 ${itemId} not in CSV`, "#dc3545");
    }

    const rec = data.record || {};
    tr.innerHTML = `
      <td>${itemId}</td>
      <td style="display:none">${data.correctBin || "-"}</td> <!-- HIDDEN COLUMN -->
      <td>${currentBin || "-"}</td>
      <td>${rec.received || "-"}</td>
      <td>${rec.statusText || "-"}</td>
      <td>${rec.category || "-"}</td>
      <td>${rec.subcategory || "-"}</td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>-</td>
    `;
    logTbody.prepend(tr);
  } catch (err) {
    console.error(err);
    alert("Scan error.");
  }
}

// ===== End Bin Audit =====
document.getElementById("endBinBtn").onclick = async () => {
  if (!currentBin) {
    alert("No active bin. Scan a Bin QR first.");
    return;
  }
  await fetch(`/audit/end/${encodeURIComponent(currentBin)}`, { method: "POST" });
  showToast(`Audit ended for Bin: ${currentBin}`, "#6c47ff");
  currentBin = null;
  document.getElementById("currentBin").textContent = "None";
};

// ===== Export Buttons =====
document.getElementById("exportLogBtn").onclick = () => {
  const rows = [
    [
      "Item ID",
      "Scanned Bin",
      "WH Received",
      "Shappi Status",
      "Category",
      "Subcategory",
      "Audit Status",
      "Resolved",
    ],
  ];
  logTbody.querySelectorAll("tr").forEach((tr) => {
    const cols = Array.from(tr.querySelectorAll("td")).map((td) =>
      td.textContent.trim()
    );
    rows.push(cols);
  });
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const s = (v ?? "").toString();
          return s.includes(",") || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(",")
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "audit_results.csv";
  a.click();
};
document.getElementById("exportSummaryBtn").onclick = () => {
  window.location.href = "/export-summary";
};

// ===== QR Scanner for Bin =====
async function scanQR() {
  return new Promise(async (resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.9)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "9999";
    document.body.appendChild(overlay);

    const video = document.createElement("video");
    video.style.width = "92vw";
    video.style.maxWidth = "640px";
    video.style.borderRadius = "12px";
    overlay.appendChild(video);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tick = async () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });

      if (code && code.data) {
        stream.getTracks().forEach((t) => t.stop());
        overlay.remove();
        resolve(code.data);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

