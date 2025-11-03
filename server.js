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

// Disable caching for static assets (avoid stale UI)
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

// --------------------
// GLOBAL VARIABLES
// --------------------
let inventoryData = [];
let inventoryMap = {};
let lastCsvTimestamp = null;
let audits = {}; // { binId: { auditor, startTime, endTime, items: [...] } }

const upload = multer({ dest: "uploads/" });

// --------------------
// CSV UPLOAD HANDLER
// --------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const uploadTimeEST = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => {
      const normalized = {};
      for (const key in d) {
        const cleanKey = key.trim().toLowerCase();
        normalized[cleanKey] = (d[key] || "").trim();
      }
      rows.push(normalized);
    })
    .on("end", () => {
      try { fs.unlinkSync(req.file.path); } catch {}

      inventoryData = rows;
      inventoryMap = {};

      for (const record of rows) {
        const itemId = (record["item id"] || "").trim().toUpperCase();
        if (itemId) inventoryMap[itemId] = record;
      }

      lastCsvTimestamp = uploadTimeEST;

      // 🔔 Emit update to all users
      io.emit("csvUpdated", {
        message: "✅ CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST
      });

      // Respond to uploader
      res.json({
        message: "✅ CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST
      });
    })
    .on("error", (err) => {
      console.error("CSV Parse Error:", err);
      res.status(500).json({ error: "CSV parsing failed" });
    });
});

// --------------------
// STATUS CHECK
// --------------------
app.get("/csv-status", (req, res) => {
  res.json({ total: inventoryData.length, uploadedAt: lastCsvTimestamp });
});

// --------------------
// AUDIT START
// --------------------
app.post("/audit/start/:binId", (req, res) => {
  const { binId } = req.params;
  const auditor = (req.query.auditor || "Unknown").toString();

  audits[binId] = {
    auditor,
    startTime: new Date().toISOString(),
    endTime: null,
    items: []
  };

  io.emit("auditStarted", { binId, auditor, startTime: audits[binId].startTime });
  res.json({ message: `Audit started for ${binId}`, auditor });
});

// --------------------
// ITEM SCAN
// --------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId) return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });
  if (!audits[binId]) return res.status(400).json({ error: "Bin not active. Scan Bin QR first." });
  if (!inventoryData.length) return res.status(400).json({ error: "No CSV loaded" });

  const normalizedItemId = (itemId || "").trim().toUpperCase();
  const record = inventoryMap[normalizedItemId];

  let status = "match";
  let expectedBin = "-";

  if (!record) {
    status = "no-bin"; // item not in CSV
  } else {
    expectedBin = (record["warehouse bin id"] || "").trim();
    if (expectedBin !== binId.trim()) status = "mismatch";
  }

  const itemRec = {
    itemId,
    expectedBin,
    scannedBin: binId,
    status, // match | mismatch | no-bin
    resolved: false,
    ts: new Date().toISOString()
  };

  audits[binId].items.unshift(itemRec);
  io.emit("itemScanned", { binId, auditor, item: itemRec });

  return res.json({
    status,
    correctBin: expectedBin !== "-" ? expectedBin : null,
    record: record ? {
      itemId,
      binId,
      received: record["received at warehouse"] || "",
      statusText: record["status"] || "",
      category: record["category"] || "",
      subcategory: record["subcategory"] || ""
    } : null
  });
});

// --------------------
// ITEM RESOLUTION
// --------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;
  if (!binId || !itemId) return res.status(400).json({ error: "Missing binId or itemId" });
  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "Audit not found for bin" });

  const itm = audit.items.find(i => i.itemId === itemId);
  if (!itm) return res.status(404).json({ error: "Item not found in audit" });
  itm.resolved = !!resolved;

  io.emit("itemResolved", { binId, itemId, resolved: !!resolved });
  res.json({ message: "Updated", binId, itemId, resolved: !!resolved });
});

// --------------------
// END AUDIT
// --------------------
app.post("/audit/end/:binId", (req, res) => {
  const { binId } = req.params;
  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "No active audit for this bin" });

  audit.endTime = new Date().toISOString();
  io.emit("auditEnded", { binId, endTime: audit.endTime, audit });
  res.json({ message: `Audit completed for ${binId}` });
});

// --------------------
// EXPORT SUMMARY
// --------------------
app.get("/export-summary", (req, res) => {
  if (!Object.keys(audits).length) {
    return res.status(400).json({ error: "No audits to export" });
  }

  const rows = [
    ["Bin ID","Auditor","Status","# Items","Accuracy %","Start Time","End Time",
     "Item ID","Expected Bin","Scanned Bin","Item Status","Resolved","Scan Timestamp"]
  ];

  for (const [binId, audit] of Object.entries(audits)) {
    const total = audit.items.length;
    const correct = audit.items.filter(i => i.status === "match").length;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;
    const statusLabel = audit.endTime ? "Completed" : "In Progress";

    audit.items.forEach(i => {
      rows.push([
        binId,
        audit.auditor,
        statusLabel,
        total,
        accuracy,
        audit.startTime || "-",
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

  const csvContent = rows.map(r => r.map(v => {
    const s = (v ?? "").toString();
    return s.includes(",") || s.includes("\n") ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_summary_${Date.now()}.csv`);
  res.send(csvContent);
});

// --------------------
// SERVER START
// --------------------
io.on("connection", () => {});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

