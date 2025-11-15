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

// Disable caching for static assets
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

// -----------------------------
// GLOBAL IN-MEMORY STATE
// -----------------------------
let inventoryData = [];
let inventoryMap = {}; // itemId → record
let lastCsvTimestamp = null;
let audits = {};       // binId → { auditor, startTime, endTime, items: [] }

const upload = multer({ dest: "uploads/" });


// -----------------------------
// CSV UPLOAD (normalization v3)
// -----------------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const uploadTimeEST = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => {
      const cleaned = {};
      for (const key in d) {
        const normalizedKey = key.trim().toLowerCase();
        cleaned[normalizedKey] = (d[key] || "").trim();
      }
      rows.push(cleaned);
    })
    .on("end", () => {
      try { fs.unlinkSync(req.file.path); } catch {}

      inventoryData = rows;
      inventoryMap = {};

      for (const rec of rows) {
        const id = (rec["item id"] || "").trim().toUpperCase();
        if (id) inventoryMap[id] = rec;
      }

      lastCsvTimestamp = uploadTimeEST;

      io.emit("csvUpdated", {
        message: "CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST
      });

      res.json({
        message: "CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST
      });
    })
    .on("error", (err) => {
      console.error("CSV parse error:", err);
      res.status(500).json({ error: "CSV parsing failed" });
    });
});


// -----------------------------
// CSV STATUS
// -----------------------------
app.get("/csv-status", (req, res) => {
  res.json({ total: inventoryData.length, timestamp: lastCsvTimestamp });
});


// -----------------------------
// START AUDIT
// -----------------------------
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


// -----------------------------
// ITEM SCAN V3.1 (remove-item logic)
// -----------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId) return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });
  if (!audits[binId]) return res.status(400).json({ error: "Bin not active. Scan Bin QR first." });
  if (!inventoryData.length) return res.status(400).json({ error: "No CSV loaded" });

  const id = (itemId || "").trim().toUpperCase();
  const record = inventoryMap[id];

  // Return structure fields
  let status = "";
  let expectedBin = record?.["warehouse bin id"]?.trim() || "";

  // -----------------------------
  // 1. NOT IN CSV
  // -----------------------------
  if (!record) {
    status = "no-bin";
    audits[binId].items.unshift({
      itemId,
      expectedBin: "-",
      scannedBin: binId,
      status,
      resolved: false,
      ts: new Date().toISOString()
    });

    return res.json({
      status: "no-bin",
      correctBin: null,
      record: null
    });
  }

  // -----------------------------
  // 2. CLOSED / CANCELED STATUSES
  // -----------------------------
  const statusText = (record["status"] || "").trim();
  const closedStatuses = ["Shappi Closed", "Abandoned", "Shappi Canceled"];

  if (closedStatuses.includes(statusText)) {
    status = "remove-item";

    audits[binId].items.unshift({
      itemId,
      expectedBin,
      scannedBin: binId,
      status,
      resolved: false,
      ts: new Date().toISOString()
    });

    return res.json({
      status: "remove-item",
      record: {
        itemId,
        binId,
        received: record["received at warehouse"] || "",
        statusText,
        category: record["category"] || "",
        subcategory: record["subcategory"] || ""
      }
    });
  }

  // -----------------------------
  // 3. MISMATCH
  // -----------------------------
  if (expectedBin && expectedBin !== binId.trim()) {
    status = "mismatch";

    audits[binId].items.unshift({
      itemId,
      expectedBin,
      scannedBin: binId,
      status,
      resolved: false,
      ts: new Date().toISOString()
    });

    return res.json({
      status: "mismatch",
      correctBin: expectedBin,
      record: {
        itemId,
        binId,
        received: record["received at warehouse"] || "",
        statusText,
        category: record["category"] || "",
        subcategory: record["subcategory"] || ""
      }
    });
  }

  // -----------------------------
  // 4. MATCH
  // -----------------------------
  status = "match";

  audits[binId].items.unshift({
    itemId,
    expectedBin,
    scannedBin: binId,
    status,
    resolved: false,
    ts: new Date().toISOString()
  });

  return res.json({
    status,
    correctBin: expectedBin,
    record: {
      itemId,
      binId,
      received: record["received at warehouse"] || "",
      statusText,
      category: record["category"] || "",
      subcategory: record["subcategory"] || ""
    }
  });
});


// -----------------------------
// RESOLVE ITEM
// -----------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;
  if (!binId || !itemId) return res.status(400).json({ error: "Missing binId or itemId" });

  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "Audit not found for this bin" });

  const itm = audit.items.find(i => i.itemId === itemId);
  if (!itm) return res.status(404).json({ error: "Item not found in audit" });

  itm.resolved = !!resolved;

  io.emit("itemResolved", { binId, itemId, resolved: !!resolved });
  res.json({ message: "Updated", binId, itemId, resolved });
});


// -----------------------------
// END AUDIT
// -----------------------------
app.post("/audit/end/:binId", (req, res) => {
  const { binId } = req.params;
  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "No active audit for this bin" });

  audit.endTime = new Date().toISOString();

  io.emit("auditEnded", { binId, endTime: audit.endTime, audit });
  res.json({ message: `Audit completed for ${binId}` });
});


// -----------------------------
// EXPORT SUMMARY
// -----------------------------
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


// -----------------------------
// START SERVER
// -----------------------------
io.on("connection", () => {});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

