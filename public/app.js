console.log("✅ app.js loaded successfully");

document.addEventListener("DOMContentLoaded", () => {
  const csvUpload = document.getElementById("csvUpload");
  const logTbody = document.getElementById("logTbody");
  const currentBinDisplay = document.getElementById("currentBin");
  let inventoryData = [];
  let auditResults = [];
  let currentBin = null;

  // ✅ CSV Upload Handler
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return alert("Please select a CSV file.");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/upload-csv", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      inventoryData = data.inventory;
      alert(`✅ ${data.total} records loaded successfully!`);
    } catch (err) {
      console.error("❌ Error uploading CSV:", err);
      alert("Error uploading CSV file.");
    }
  });

  // ✅ QR Code Scanner
  async function startScan(mode) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.setAttribute("playsinline", true);
      video.play();

      const overlay = document.createElement("div");
      overlay.classList.add("scanner-overlay");
      document.body.appendChild(video);
      document.body.appendChild(overlay);

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      const qrDetector = new BarcodeDetector({ formats: ["qr_code"] });

      const scanLoop = async () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            const barcodes = await qrDetector.detect(canvas);
            if (barcodes.length > 0) {
              const code = barcodes[0].rawValue;
              handleScanResult(code, mode);
              stopScan();
              return;
            }
          } catch (err) {
            console.error("❌ Barcode detection error:", err);
          }
        }
        requestAnimationFrame(scanLoop);
      };

      const stopScan = () => {
        stream.getTracks().forEach((track) => track.stop());
        video.remove();
        overlay.remove();
      };

      scanLoop();
    } catch (err) {
      alert("Camera access denied or not supported. Please check permissions.");
      console.error("Camera error:", err);
    }
  }

  // ✅ Handle QR result
  function handleScanResult(code, mode) {
    if (mode === "bin") {
      currentBin = code;
      currentBinDisplay.textContent = code;
    } else if (mode === "item") {
      const record = inventoryData.find((r) => r["Item ID"] === code);
      const expectedBin = record ? record["Warehouse Bin ID"] : "Unknown";
      const status = expectedBin === currentBin ? "Match" : "Mismatch";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${code}</td><td>${expectedBin}</td><td>${currentBin}</td><td>${status}</td>`;
      tr.className = status.toLowerCase();
      logTbody.prepend(tr);
      auditResults.push({ code, expectedBin, currentBin, status });
    }
  }

  // ✅ Button Listeners
  document.getElementById("scanBinBtn").onclick = () => startScan("bin");
  document.getElementById("scanItemBtn").onclick = () => startScan("item");
  document.getElementById("exportCsvBtn").onclick = () => {
    const csvContent = [
      ["Item ID", "Expected Bin", "Scanned Bin", "Status"],
      ...auditResults.map((r) => [r.code, r.expectedBin, r.currentBin, r.status]),
    ]
      .map((e) => e.join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shappi-audit.csv";
    a.click();
  };

  // ✅ PWA Install Prompt
  let deferredPrompt;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.createElement("button");
    installBtn.textContent = "📲 Install Shappi App";
    installBtn.className = "install-btn";
    installBtn.onclick = async () => {
      installBtn.style.display = "none";
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
    document.body.appendChild(installBtn);
  });
});

// ✅ Register the Service Worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((reg) => console.log("✅ Service Worker registered:", reg.scope))
      .catch((err) => console.error("❌ Service Worker registration failed:", err));
  });
}

