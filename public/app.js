document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ app.js loaded");

  let currentBin = null;
  let inventoryMap = {};
  let auditResults = [];

  const logTbody = document.getElementById("logTbody");
  const currentBinDisplay = document.getElementById("currentBin");
  const csvUpload = document.getElementById("csvUpload");

  // ✅ CSV Upload
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
      alert(`✅ ${data.message} (${data.total} records loaded)`);
    } catch (err) {
      console.error("❌ Upload error:", err);
      alert("Error uploading CSV.");
    }
  });

  // ✅ Start QR Scanning
  async function startQRScan(type) {
    console.log("Starting QR scan:", type);
    const video = document.createElement("video");
    video.style.width = "100%";
    video.style.maxWidth = "400px";
    video.style.borderRadius = "10px";
    document.body.appendChild(video);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      const scan = async () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });

          if (code) {
            console.log("✅ QR detected:", code.data);
            stream.getTracks().forEach((t) => t.stop());
            video.remove();

            if (type === "bin") {
              currentBin = code.data.trim();
              currentBinDisplay.textContent = currentBin;
              alert(`✅ Bin set to: ${currentBin}`);
            } else {
              const itemId = code.data.trim();
              const tr = document.createElement("tr");
              const res = await fetch(`/check-item/${itemId}/${currentBin}`);
              const data = await res.json();

              let status = data.status;
              tr.innerHTML = `
                <td>${itemId}</td>
                <td>${data.correctBin || "-"}</td>
                <td>${currentBin || "-"}</td>
                <td>${status}</td>
              `;
              logTbody.prepend(tr);
            }
            return;
          }
        }
        requestAnimationFrame(scan);
      };
      scan();
    } catch (err) {
      console.error("❌ Camera access error:", err);
      alert("Camera access denied or not supported. Please check permissions and try again.");
      video.remove();
    }
  }

  // ✅ Button bindings
  document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
  document.getElementById("scanItemBtn").onclick = () => startQRScan("item");

  // ✅ PWA install
  let deferredPrompt;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.createElement("button");
    btn.textContent = "Install Shappi Inventory App";
    btn.style.position = "fixed";
    btn.style.bottom = "20px";
    btn.style.left = "50%";
    btn.style.transform = "translateX(-50%)";
    btn.style.padding = "10px 20px";
    btn.style.backgroundColor = "#6c47ff";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "10px";
    btn.onclick = async () => {
      btn.remove();
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log("User response to install:", outcome);
      deferredPrompt = null;
    };
    document.body.appendChild(btn);
  });
});
