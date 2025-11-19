// -------------------------------
// Shappi Inventory Backend v4.0
// -------------------------------

import express from "express";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import moment from "moment-timezone";

// -----------------------------------------------------
// AUTO-CREATE REQUIRED FOLDERS (Fixes Render CSV crash)
// -----------------------------------------------------
if (!fs.existsSync("data")) {
  fs.mkdirSync("data", { recursive: true });
}
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads", { recursive: true });
}

// -----------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

// CSV storage
let csvMap = new Map(); // itemId → row
let csvBins = new Set(); // valid bin list

// -----------------------------------------------------
// Multer upload storage
// -----------------------------------------------------
const upload = multer({ dest: "uploads/" });

// -----------------------------------------------------
// Helper: Load CSV into memory + update metadata
// -----------------------------------------------------
async function loadCsvToMemory(filePath) {
  return new Promise((resolve, reject) => {
    const tempMap = new Map();
    const bins = new Set();

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const itemId = String(row.ItemID || row.itemId || "").trim();
        const bin = String(row.ExpectedBin || row.expectedBin || "").trim().toUpperCase();

        if (itemId) {
          tempMap.set(itemId, {
            received: row.Received || row.received || "-",
            statusText: row.Status || row.statusText || "-",
            expectedBin: bin || "-",
            category: row.Category || "",
            subcategory: row.Subcategory || ""
          });
        }

        if (bin) bins.add(bin);
      })
      .on("end", () => {
        csvMap = tempMap;
        csvBins = bins;

        const meta = {
          total: csvMap.size,
          uploadedAt: moment().tz("America/New_York").format("MMM DD, YYYY HH:mm")
        };

        fs.writeFileSync("data/csv-meta.json", JSON.stringify(meta, null, 2));

        resolve(meta);
      })
      .on("error", reject);
  });
}

// -----------------------------------------------------
// Upload CSV
// -----------------------------------------------------
app.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No CSV uploaded" });

    const meta = await loadCsvToMemory(req.file.path);

    io.emit("csvUpdated", meta);

    res.json(meta);
  } catch (err) {
    console.error("CSV upload failed", err);
    res.status(500).json({ error: "Failed to process CSV" });
  }
});

// -----------------------------------------------------
// CSV status endpoint (Fix for second-user timestamp)
// -----------------------------------------------------
app.get("/csv-status", (req, res) => {
  try {
    if (fs.existsSync("data/csv-meta.json")) {
      const meta = JSON.parse(fs.readFileSync("data/csv-meta.json"));
      meta.total = csvMap.size;
      return res.json(meta);
    }

    res.json({ total: 0, uploadedAt: null });
  } catch (err) {
    console.error("CSV-status error", err);
    res.json({ total: 0, uploadedAt: null });
  }
});

// -----------------------------------------------------
// Start audit for a bin (validate 3-letter + exists in CSV)
// -----------------------------------------------------
app.post("/audit/start/:bin", (req, res) => {
  const auditor = req.query.auditor || "Unknown";
  const rawBin = req.params.bin.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(rawBin)) {
    return res.status(400).json({ error: "Invalid bin format. Must be 3 letters." });
  }

  if (!csvBins.has(rawBin)) {
    return res.status(400).json({ error: "Bin not found in CSV." });
  }

  console.log(`Audit started for BIN ${rawBin} by ${auditor}`);
  res.json({ ok: true });
});

// -----------------------------------------------------
// Scan an item
// -----------------------------------------------------
app.post("/audit/scan", (req, res) => {
  const { itemId, binId } = req.body;
  const auditor = req.query.auditor || "Unknown";

  const record = csvMap.get(itemId);

  if (!record) {
    return res.json({
      status: "no-bin",
      record: {}
    });
  }

  let status = "";

  if (!record.expectedBin || record.expectedBin === "-") {
    status = "no-bin";
  } else if (record.expectedBin === binId) {
    status = "match";
  } else if (record.statusText?.toLowerCase().includes("canceled")) {
    status = "remove-item";
  } else {
    status = "mismatch";
  }

  res.json({
    status,
    correctBin: record.expectedBin,
    record
  });
});

// -----------------------------------------------------
// Resolve mismatch toggle
// -----------------------------------------------------
app.post("/audit/resolve", (req, res) => {
  const { itemId, resolved } = req.body;
  console.log(`Resolved toggle → ${itemId}: ${resolved}`);
  io.emit("itemResolved", { itemId, resolved });

  res.json({ ok: true });
});

// -----------------------------------------------------
// Export full audit summary
// -----------------------------------------------------
app.get("/export-summary", (req, res) => {
  let csvText = "Item ID,Expected Bin,Received,Status,Category,Subcategory\n";

  csvMap.forEach((row, id) => {
    csvText += `${id},${row.expectedBin},${row.received},${row.statusText},${row.category},${row.subcategory}\n`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=audit_summary.csv");
  res.send(csvText);
});

// -----------------------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Shappi Inventory Backend v4.0 running on ${PORT}`);
});

