import { BrowserMultiFormatReader } from "https://cdn.jsdelivr.net/npm/@zxing/browser@latest/+esm";

document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ app.js (ZXing) loaded");

  let currentBin = null;
  const logTbody = document.getElementById("logTbody");
  const currentBinDisplay = document.getElementById("currentBin");
  const csvUpload = document.getElementById("csvUpload");

  // === CSV Upload ===
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return alert("Please select a CSV file.");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/upload-csv", { method: "POST", body: formData });
      const data = await res.json();
      alert(`✅ ${data.message} (${data.total} records loaded)`);
    } catch (err) {
      console.error("Upload error:", err);
      alert("Error uploading CSV.");
    }
  });

  // === Start QR Scanner ===
  async function startQRScan(type) {
    console.log("Starting QR scan for:", type);
    const codeReader = new BrowserMultiFormatReader();

    const previewElem = document.createElement("video");
    previewElem.style.width = "100%";
    previewElem.style.maxWidth = "420px";
    previewElem.style.borderRadius = "12px";
    previewElem.style.marginTop = "20px";
    document.body.appendChild(previewElem);

    alert("📸 Point your camera at the QR code...");

    try {
      const result = await codeReader.decodeOnceFromVideoDevice(undefined, previewElem);
      console.log("✅ QR Detected:", result.text);

      // === Stop camera stream cleanly ===
      const stream = previewElem.srcObject;
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
      previewElem.srcObject = null;
      previewElem.remove();
      codeReader.reset();

      // === Force UI refresh (fixes iOS black screen) ===
      document.body.style.backgroundColor = "#0B0C2A";
      setTimeout(() => window.scrollTo(0, 0), 100);

      // === Handle scanned data ===
      if (type === "bin") {
        currentBin = result.text.trim();
        currentBinDisplay.textContent = currentBin;
        alert(`✅ Bin set to: ${currentBin}`);
      } else {
        const itemId = result.text.trim();
        const res = await fetch(`/check-item/${itemId}/${currentBin}`);
        const data = await res.json();

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${itemId}</td>
          <td>${data.correctBin || "-"}</td>
          <td>${currentBin || "-"}</td>
          <td>${data.status}</td>
        `;
        logTbody.prepend(tr);
      }
    } catch (err) {
      console.error("❌ Scan error:", err);
      alert("Camera access denied or scanning failed. Please enable camera permissions in Safari Settings.");
      previewElem.remove();
      codeReader.reset();
    }
  }

  document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
  document.getElementById("scanItemBtn").onclick = () => startQRScan("item");

  // === PWA Install Button ===
  let deferredPrompt;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;

    const installBtn = document.createElement("button");
    installBtn.textContent = "Install Shappi Inventory App";
    installBtn.style.position = "fixed";
    installBtn.style.bottom = "20px";
    installBtn.style.left = "50%";
    installBtn.style.transform = "translateX(-50%)";
    installBtn.style.padding = "10px 20px";
    installBtn.style.backgroundColor = "#6c47ff";
    installBtn.style.color = "#fff";
    installBtn.style.border = "none";
    installBtn.style.borderRadius = "10px";
    installBtn.onclick = async () => {
      installBtn.remove();
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log("User install response:", outcome);
      deferredPrompt = null;
    };
    document.body.appendChild(installBtn);
  });
});

