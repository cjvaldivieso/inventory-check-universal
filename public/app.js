const socket = io();

let currentBin = null;
let scanning = false;
let lastScanTime = 0;

const SCAN_DELAY = 1200;

document.getElementById("scanBinBtn").onclick = startBinScan;
document.getElementById("scanItemBtn").onclick = startItemScan;

async function startBinScan() {
  const code = await launchScanner("Scan Bin QR");

  if (!code.match(/^[A-Z]{3}$/)) return toast("Invalid Bin QR");

  const auditor = localStorage.getItem("auditorName") || "Unknown";

  const res = await fetch(`/audit/start/${code}?auditor=${auditor}`, { method: "POST" });
  const data = await res.json();

  if (data.error) return toast(data.error);

  currentBin = code;
  document.getElementById("currentBin").innerText = code;

  toast(`Bin ${code} loaded`);
  startItemScan();
}

async function startItemScan() {
  if (!currentBin) return toast("Scan bin first");

  const code = await launchScanner("Scanning Items");
  if (!code) return;

  const now = Date.now();
  if (now - lastScanTime < SCAN_DELAY) return;

  lastScanTime = now;

  const auditor = localStorage.getItem("auditorName") || "Unknown";

  const res = await fetch(`/audit/scan?auditor=${auditor}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ binId: currentBin, itemId: code })
  });

  const data = await res.json();

  addRow(code, data.status);
}

function addRow(item, status) {
  const table = document.getElementById("logTbody");

  if (document.querySelector(`[data-item="${item}"]`)) return;

  const tr = document.createElement("tr");
  tr.dataset.item = item;

  tr.innerHTML = `
    <td>${item}</td>
    <td>${currentBin}</td>
    <td>${status}</td>
  `;

  table.prepend(tr);
}

async function launchScanner(label) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:#000c;z-index:1000;color:white;padding:20px">
        <h2>${label}</h2>
        <video id="cam" autoplay style="width:100%"></video>
        <button onclick="this.parentElement.remove()">Stop</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = document.getElementById("cam");

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(stream => {
        video.srcObject = stream;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const tick = () => {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);

          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, canvas.width, canvas.height);

          if (code?.data) {
            video.srcObject.getTracks().forEach(t => t.stop());
            overlay.remove();
            resolve(code.data.trim());
          } else {
            requestAnimationFrame(tick);
          }
        };
        tick();
      });
  });
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.innerText = msg;
  el.style.display = "block";
  setTimeout(() => el.style.display = "none", 5000);
}

