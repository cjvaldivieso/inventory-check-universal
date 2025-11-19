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

// NO-CACHE for all static files (fixes Chrome Desktop issues)
app.use(express.static("public", {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

// --------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------
let inventoryData = [];
let inventoryMap  = {};
let lastCsvTimestamp = null;
let audits = {};

const upload = multer({ dest: "uploads/" });

// --------------------------------------------------
// CSV UPLOAD
// --------------------------------------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const timestamp = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => {
      const clean = {};
      for (const k in d) clean[k.trim().toLowerCase()] = (d[k] || "").trim();
      rows.push(clean);
    })
    .on("end", () => {
      try { fs.unlinkSync(req.file.path); } catch {}

      inventoryData = rows;
      inventoryMap = {};

      for (const r of rows) {
        const id = (r["item id"] || "").trim().toUpperCase();
        if (id) inventoryMap[id] = r;
      }

      lastCsvTimestamp = timestamp;

      io.emit("csvUpdated", {
        total: rows.length,
        uploadedAt: timestamp
      });

      res.json({
        total: rows.length,
        uploadedAt: timestamp
      });
    })
    .on("error", (err) => {
      console.error("CSV Parse Error:", err);
      res.status(500).json({ error: "CSV parsing failed" });
    });
});

// --------------------------------------------------
// CSV STATUS
// --------------------------------------------------
app.get("/csv-status", (req, res) => {
  res.json({
    total: inventoryData.length,
    uploadedAt: lastCsvTimestamp
  });
});

// --------------------------------------------------
// AUDIT START
// --------------------------------------------------
app.post("/audit/start/:binId", (req, res) => {
  const { binId } = req.params;
  const auditor   = req.query.auditor || "Unknown";

  audits[binId] = {
    auditor,
    startTime: new Date().toISOString(),
    endTime: null,
    items: []
  };

  io.emit("auditStarted", { binId });
  res.json({ message: "audit started" });
});

// --------------------------------------------------
// ITEM SCAN
// --------------------------------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = req.query.auditor || "Unknown";

  if (!audits[binId])
    return res.status(400).json({ error: "no active bin" });

  const id = (itemId || "").trim().toUpperCase();
  const record = inventoryMap[id];

  let status = "match";
  let expectedBin = "-";

  if (!record) {
    status = "no-bin";
  } else {
    expectedBin = (record["warehouse bin id"] || "").trim().toUpperCase();
    if (expectedBin !== binId.trim().toUpperCase()) status = "mismatch";
  }

  const rec = {
    itemId,
    expectedBin,
    scannedBin: binId,
    status,
    resolved: false,
    ts: new Date().toISOString()
  };

  audits[binId].items.unshift(rec);

  io.emit("itemScanned", {
    binId,
    item: rec
  });

  res.json({
    status,
    correctBin: expectedBin,
    record: record ? {
      received: record["received at warehouse"] || "",
      statusText: record["status"] || ""
    } : null
  });
});

// --------------------------------------------------
// RESOLVE
// --------------------------------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;

  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "audit not found" });

  const item = audit.items.find(i => i.itemId === itemId);
  if (!item) return res.status(404).json({ error: "item not found" });

  item.resolved = !!resolved;

  io.emit("itemResolved", { binId, itemId, resolved });
  res.json({ updated: true });
});

// --------------------------------------------------
// END AUDIT
// --------------------------------------------------
app.post("/audit/end/:binId", (req, res) => {
  const a = audits[req.params.binId];
  if (!a) return res.status(404).json({ error: "no active audit" });

  a.endTime = new Date().toISOString();
  res.json({ message: "audit ended" });
});

// --------------------------------------------------
// FULL SUMMARY CSV EXPORT
// --------------------------------------------------
app.get("/export-summary", (req, res) => {
  const rows = [
    ["Bin","Auditor","Item ID","Expected","Scanned","Status","Resolved","Timestamp"]
  ];

  for (const [bin, audit] of Object.entries(audits)) {
    audit.items.forEach(i => {
      rows.push([
        bin,
        audit.auditor,
        i.itemId,
        i.expectedBin,
        i.scannedBin,
        i.status,
        i.resolved ? "YES" : "NO",
        i.ts
      ]);
    });
  }

  const csv = rows.map(r => r.join(",")).join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_${Date.now()}.csv`);
  res.send(csv);
});

// --------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on " + PORT));

