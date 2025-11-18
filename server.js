/* ================================================
   SHAPPI INVENTORY APP — SERVER (v4.0)
   Fully Bundled:
   - CSV persistence
   - Bin validation
   - Audit system
   - Scan dedupe
   - Mobile-safe endpoints
================================================ */

import express from "express";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import moment from "moment-timezone";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());

// Static files (no cache)
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// --------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------
global.csvData = [];
global.csvUploadedAt = null;
global.validBins = new Set();

let audits = {}; // { binId: { auditor, startTime, items: [...] } }

const upload = multer({ dest: "uploads/" });


// --------------------------------------------------
// LOAD PERSISTED CSV METADATA ON STARTUP
// --------------------------------------------------
try {
  if (fs.existsSync("data/csv-meta.json")) {
    const meta = JSON.parse(fs.readFileSync("data/csv-meta.json"));
    global.csvUploadedAt = meta.uploadedAt;
  }
} catch {}


// --------------------------------------------------
// CSV UPLOAD
// --------------------------------------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const rows = [];
  const timestamp = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {
      rows.push({
        itemId: (row["Item ID"] || "").trim().toUpperCase(),
        bin: (row["Warehouse Bin ID"] || "").trim().toUpperCase(),
        received: (row["Received At Warehouse"] || "").trim(),
        status: (row["Status"] || "").trim(),
        category: (row["Category"] || "").trim(),
        subcategory: (row["Subcategory"] || "").trim()
      });
    })
    .on("end", () => {
      try { fs.unlinkSync(req.file.path); } catch {}

      global.csvData = rows;
      global.csvUploadedAt = timestamp;

      // Build valid bin set
      global.validBins = new Set(rows.map(r => r.bin).filter(b => b));

      // Persist metadata
      fs.writeFileSync("data/csv-meta.json", JSON.stringify({
        uploadedAt: timestamp,
        total: rows.length
      }, null, 2));

      io.emit("csvUpdated", {
        total: rows.length,
        uploadedAt: timestamp,
        bins: [...global.validBins]
      });

      res.json({
        total: rows.length,
        uploadedAt: timestamp,
        bins: [...global.validBins]
      });
    });
});


// --------------------------------------------------
// CSV STATUS (visible on load for EVERY user)
// --------------------------------------------------
app.get("/csv-status", (req, res) => {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync("data/csv-meta.json"));
  } catch {
    meta = { uploadedAt: null, total: 0 };
  }

  res.json({
    total: meta.total || global.csvData.length,
    uploadedAt: meta.uploadedAt,
    bins: [...global.validBins]
  });
});


// --------------------------------------------------
// AUDIT: START
// --------------------------------------------------
app.post("/audit/start/:binId", (req, res) => {
  let bin = req.params.binId.trim().toUpperCase();
  const auditor = (req.query.auditor || "Unknown").toString();

  // BIN VALIDATION
  if (!/^[A-Z]{3}$/.test(bin)) {
    return res.status(400).json({ error: "Invalid Bin Format. Must be 3 letters." });
  }

  if (!global.validBins.has(bin)) {
    return res.status(400).json({ error: "Bin not found in CSV." });
  }

  audits[bin] = {
    auditor,
    startTime: new Date().toISOString(),
    endTime: null,
    items: [] // { itemId, status, resolved, ... }
  };

  io.emit("auditStarted", { bin, auditor });
  res.json({ message: `Audit started for ${bin}`, auditor });
});


// --------------------------------------------------
// AUDIT: SCAN ITEM
// --------------------------------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = req.query.auditor || "Unknown";

  if (!binId || !itemId)
    return res.status(400).json({ error: "Missing binId or itemId" });

  const bin = binId.toUpperCase();
  const item = itemId.trim().toUpperCase();

  if (!audits[bin])
    return res.status(400).json({ error: "No active audit for this bin" });

  const csvItem = global.csvData.find(r => r.itemId === item);

  let status = "match";
  let expectedBin = csvItem?.bin || "-";

  if (!csvItem) {
    status = "no-bin";
  } else if (expectedBin !== bin) {
    status = "mismatch";
  }

  if (
    csvItem &&
    ["SHAPPI CLOSED", "SHAPPI CANCELED", "ABANDONED"].includes(csvItem.status.toUpperCase())
  ) {
    status = "remove-item";
  }

  // DEDUPE SCANS (server-side)
  const existing = audits[bin].items.find(i => i.itemId === item);
  if (existing) {
    existing.status = status;
    existing.ts = new Date().toISOString();
  } else {
    audits[bin].items.unshift({
      itemId: item,
      expectedBin,
      scannedBin: bin,
      status,
      resolved: false,
      ts: new Date().toISOString()
    });
  }

  return res.json({
    status,
    correctBin: expectedBin !== "-" ? expectedBin : null,
    record: csvItem || null
  });
});


// --------------------------------------------------
// AUDIT: RESOLVE ITEM
// --------------------------------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;

  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "Audit not found" });

  const item = audit.items.find(i => i.itemId === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  item.resolved = !!resolved;

  io.emit("itemResolved", { binId, itemId, resolved: !!resolved });
  res.json({ success: true });
});


// --------------------------------------------------
// AUDIT: END
// --------------------------------------------------
app.post("/audit/end/:binId", (req, res) => {
  const bin = req.params.binId;

  if (!audits[bin]) return res.status(404).json({ error: "No active audit" });

  audits[bin].endTime = new Date().toISOString();

  io.emit("auditEnded", { bin, endTime: audits[bin].endTime });

  res.json({ message: `Audit completed for ${bin}` });
});


// --------------------------------------------------
// EXPORT FULL SUMMARY (CSV)
// --------------------------------------------------
app.get("/export-summary", (req, res) => {
  if (!Object.keys(audits).length)
    return res.status(400).json({ error: "No audits to export" });

  const rows = [
    [
      "Bin ID","Auditor","Audit Status","# Items","Accuracy %",
      "Start Time","End Time",
      "Item ID","Expected Bin","Scanned Bin",
      "Item Status","Resolved","Timestamp"
    ]
  ];

  for (const [bin, audit] of Object.entries(audits)) {
    const total = audit.items.length;
    const correct = audit.items.filter(i => i.status === "match").length;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;
    const statusLabel = audit.endTime ? "Completed" : "In Progress";

    audit.items.forEach(i => {
      rows.push([
        bin,
        audit.auditor,
        statusLabel,
        total,
        accuracy,
        audit.startTime,
        audit.endTime || "-",
        i.itemId,
        i.expectedBin,
        i.scannedBin,
        i.status,
        i.resolved ? "Yes" : "No",
        i.ts
      ]);
    });
  }

  const csv = rows.map(r => r.join(",")).join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_summary_${Date.now()}.csv`);
  res.send(csv);
});


// --------------------------------------------------
// SERVER START
// --------------------------------------------------
io.on("connection", () => {});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Shappi Inventory Backend v4.0 running on ${PORT}`)
);

