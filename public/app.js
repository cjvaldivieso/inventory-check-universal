document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ Shappi Inventory App Loaded");

  let currentBin = null;
  let scannedItems = [];
  let inventoryMap = {};
  let summary = { scanned: 0, correct: 0, misplaced: 0, missing: 0 };

  const csvUpload = document.getElementById("csvUpload");
  const timestampEl = document.getElementById("timestamp");
  const logTbody = document.getElementById("logTbody");
  const currentBinDisplay = document.getElementById("currentBin");

  // Load persisted timestamp
  const savedTs = localStorage.getItem("shappi_csv_timestamp");
  if (savedTs) timestampEl.textContent = `CSV last updated: ${savedTs}`;

  // Handle CSV upload
  if (csvUpload) {
    csvUpload.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return alert("Please select a CSV file.");

      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch("/upload-csv", { method: "POST", body: formData });
        const data = await res.json();

        // Save timestamp (local device time)
        const ts = new Date().toLocaleString();
        localStorage.setItem("shappi_csv_timestamp", ts);
        timestampEl.textContent = `CSV last updated: ${ts}`;

        alert(`✅ CSV uploaded: ${data.total} records loaded`);
      } catch (err) {
        console.error("Upload failed:", err);
        alert("❌ Error uploading CSV.");
      }
    });
  }

  // QR Scanner setup
  async function startQRScan(type) {
    console.log("🎥 Starting QR scan:", type);
    const video = document.createElement("video");
    video.style.width = "100%";
    video.style.maxWidth = "400px";
    video.style.borderRadius = "10px";
    video.style.margin = "10px auto";
    video.setAttribute("playsinline", true);
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
            console.log("📦 QR detected:", code.data);
            const value = code.data.trim();

            if (type === "bin") {
              currentBin = value;
              currentBinDisplay.textContent = `Current Bin: ${value}`;
              alert(`✅ Bin set to ${value}`);
            } else if (type === "item" && currentBin) {
              const itemId = value;
              scannedItems.push({ itemId, bin: currentBin });

              const res = await fetch(`/check-item/${itemId}/${currentBin}`);
              const data = await res.json();

              const tr = document.createElement("tr");
              tr.innerHTML = `
                <td>${itemId}</td>
                <td>${data.correctBin || "-"}</td>
                <td>${data.whReceived || "-"}</td>
                <td>${data.status || "-"}</td>
                <td>${data.category || "-"}</td>
                <td>${data.subcategory || "-"}</td>
                <td>${data.result || "scanned"}</td>
              `;
              logTbody.prepend(tr);

              summary.scanned++;
              if (data.result === "correct") summary.correct++;
              if (data.result === "misplaced") summary.misplaced++;
              updateSummary();
            }

            stream.getTracks().forEach((t) => t.stop());
            video.remove();
            return;
          }
        }
        requestAnimationFrame(scan);
      };

      scan();
    } catch (err) {
      console.error("Camera access error:", err);
      alert("Camera access denied or not supported. Please check permissions.");
      video.remove();
    }
  }

  function updateSummary() {
    document.getElementById("sumScanned").textContent = summary.scanned;
    document.getElementById("sumCorrect").textContent = summary.correct;
    document.getElementById("sumMisplaced").textContent = summary.misplaced;
  }

  // Buttons
  document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
  document.getElementById("scanItemBtn").onclick = () => startQRScan("item");

  // Export summary
  document.getElementById("exportSummaryBtn").onclick = () => {
    const rows = [
      ["Scanned Items", summary.scanned],
      ["Correct", summary.correct],
      ["Misplaced", summary.misplaced],
      ["Missing (by CSV)", summary.missing],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inventory-summary.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
});

