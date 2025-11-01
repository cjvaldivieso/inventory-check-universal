document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ Shappi app.js loaded");

  let currentBin = null;
  let inventoryData = [];
  let auditResults = [];

  const logTbody = document.getElementById("logTbody");
  const currentBinDisplay = document.getElementById("currentBin");
  const csvUpload = document.getElementById("csvUpload");
  const timestampDisplay = document.getElementById("timestamp");
  const summaryCounts = document.getElementById("summaryCounts");

  // ✅ Show last CSV timestamp if stored
  const lastCsvTime = localStorage.getItem("csvTimestamp");
  if (lastCsvTime) timestampDisplay.textContent = `Last CSV loaded: ${lastCsvTime}`;

  // ✅ CSV Upload
  csvUpload.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return alert("Please select a CSV file.");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/upload-csv", { method: "POST", body: formData });
      const data = await res.json();

      inventoryData = data.inventory || [];
      const timestamp = new Date().toLocaleString();
      localStorage.setItem("csvTimestamp", timestamp);
      timestampDisplay.textContent = `Last CSV loaded: ${timestamp}`;
      alert(`✅ CSV Loaded (${inventoryData.length} records)`);
    } catch (err) {
      console.error("Upload error:", err);
      alert("Error uploading CSV.");
    }
  });

  // ✅ QR Scanning
  async function startQRScan(type) {
    console.log("📷 Starting QR scan:", type);
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
      const ctx = canvas.getContext("2d");

      const scan = async () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });

          if (code) {
            console.log("QR detected:", code.data);
            const qrValue = code.data.trim();

            if (type === "bin") {
              currentBin = qrValue;
              currentBinDisplay.textContent = currentBin;
              alert(`✅ Bin set: ${currentBin}`);
            } else if (type === "item") {
              const record = inventoryData.find((r) => r["Item ID"] === qrValue);
              const tr = document.createElement("tr");

              if (record) {
                const expectedBin = record["Warehouse Bin ID"];
                const match = expectedBin === currentBin;
                const statusClass = match ? "status-match" : "status-mismatch";
                const result = match ? "✅ Match" : `⚠️ Misplaced (Should be: ${expectedBin})`;

                tr.innerHTML = `
                  <td>${record["Item ID"]}</td>
                  <td>${record["Warehouse Bin ID"]}</td>
                  <td>${formatDate(record["Received at Warehouse"])}</td>
                  <td>${record["status"]}</td>
                  <td>${record["category"]}</td>
                  <td>${record["subcategory"]}</td>
                  <td class="${statusClass}">${result}</td>
                `;
                auditResults.push({ ...record, result });
              } else {
                tr.innerHTML = `
                  <td>${qrValue}</td>
                  <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
                  <td class="status-missing">❌ Missing</td>
                `;
                auditResults.push({ "Item ID": qrValue, result: "Missing" });
              }
              logTbody.prepend(tr);
              updateSummary();
            }

            // Auto-continue scanning
            requestAnimationFrame(() => scan());
            return;
          }
        }
        requestAnimationFrame(scan);
      };
      scan();
    } catch (err) {
      console.error("Camera error:", err);
      alert("Camera access denied or unsupported.");
      video.remove();
    }
  }

  // ✅ Utility: Format Date
  function formatDate(dateStr) {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString("en-US");
  }

  // ✅ Summary
  function updateSummary() {
    const correct = auditResults.filter((r) => r.result.includes("Match")).length;
    const misplaced = auditResults.filter((r) => r.result.includes("Misplaced")).length;
    const missing = auditResults.filter((r) => r.result.includes("Missing")).length;

    summaryCounts.innerHTML = `
      <p>✅ Correct: ${correct} | ⚠️ Misplaced: ${misplaced} | ❌ Missing: ${missing}</p>
    `;
  }

  // ✅ Export Summary
  document.getElementById("exportSummaryBtn").addEventListener("click", () => {
    const csvContent = [
      ["Item ID", "Warehouse Bin ID", "WH Received", "Shappi Status", "Category", "Subcategory", "Result"],
      ...auditResults.map((r) => [
        r["Item ID"] || "",
        r["Warehouse Bin ID"] || "",
        formatDate(r["Received at Warehouse"]),
        r["status"] || "",
        r["category"] || "",
        r["subcategory"] || "",
        r["result"] || "",
      ]),
    ]
      .map((row) => row.join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shappi_inventory_summary_${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
  });

  // ✅ Button Events
  document.getElementById("scanBinBtn").onclick = () => startQRScan("bin");
  document.getElementById("scanItemBtn").onclick = () => startQRScan("item");
});

