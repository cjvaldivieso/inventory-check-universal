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

// Serve static files with no-cache for HTML/CSS/JS
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

// --------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------
let inventoryData = [];
let inventoryMap  = {}; // ITEM ID → record
let lastCsvTimestamp = null;
let audits = {};        // binId → { auditor, startTime, items[] }

const upload = multer({ dest: "uploads/" });

// --------------------------------------------------
// CSV UPLOAD
// --------------------------------------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const uploadTime = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => {
      const clean = {};
      for (const k in d) {
        clean[k.trim().toLowerCase()] = (d[k] || "").toString().trim();
      }
      rows.push(clean);
    })
    .on("end", () => {
      try { fs.unlinkSync(req.file.path); } catch {}

      inventoryData = rows;
      inventoryMap  = {};
      lastCsvTimestamp = uploadTime;

      for (const row of rows) {
        const id = (row["item id"] || "").toUpperCase();
        if (id) inventoryMap[id] = row;
      }

      io.emit("csvUpdated", {
        total: rows.length,
        uploadedAt: uploadTime
      });

      res.json({
        message: "CSV uploaded",
        total: rows.length,
        uploadedAt: uploadTime
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
// BIN VALIDATION ENDPOINT (used by front-end)
// --------------------------------------------------
app.get("/validate-bin/:binId", (req, res) => {
  const bin = req.params.binId.toUpperCase();

  const valid = inventoryData.some(row =>
    (row["warehouse bin id"] || "").toUpperCase() === bin
  );

  res.json({ valid });
});

// --------------------------------------------------
// START AUDIT FOR BIN
// --------------------------------------------------
app.post("/audit/start/:binId", (req, res) => {
  const binId = req.params.binId.toUpperCase();
  const auditor = (req.query.auditor || "Unknown").toString();

  audits[binId] = {
    auditor,
    startTime: new Date().toISOString(),
    items: []
  };

  io.emit("auditStarted", { binId, auditor });
  res.json({ message: `Audit started for ${binId}`, auditor });
});

// --------------------------------------------------
// SCAN ITEM
// --------------------------------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId) return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  const bin = binId.toUpperCase();
  const id  = itemId.toUpperCase();

  if (!audits[bin]) {
    return res.status(400).json({ error: "Bin not active. Scan bin first." });
  }

  const record = inventoryMap[id];
  let status = "match";
  let expectedBin = record?.["warehouse bin id"] || "-";

  if (!record) {
    status = "no-bin";
  } else {
    const s = (record["status"] || "").toLowerCase();
    if (["shappi closed", "abandoned", "shappi canceled"].includes(s)) {
      status = "remove-item";
    } else if ((expectedBin || "").toUpperCase() !== bin) {
      status = "mismatch";
    }
  }

  const auditEntry = {
    itemId: id,
    expectedBin,
    scannedBin: bin,
    status,
    resolved: false,
    ts: new Date().toISOString()
  };

  audits[bin].items.unshift(auditEntry);
  io.emit("itemScanned", { binId: bin, auditor, item: auditEntry });

  res.json({
    status,
    correctBin: expectedBin !== "-" ? expectedBin : null,
    record: record ? {
      expectedBin,
      received: record["received at warehouse"] || "",
      statusText: record["status"] || ""
    } : null
  });
});

// --------------------------------------------------
// RESOLVE MOVE
// --------------------------------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;
  const bin = (binId || "").toUpperCase();
  const id  = (itemId || "").toUpperCase();

  if (!audits[bin]) return res.status(404).json({ error: "Audit not found" });

  const row = audits[bin].items.find(i => i.itemId === id);
  if (!row) return res.status(404).json({ error: "Item not found in audit" });

  row.resolved = !!resolved;

  io.emit("itemResolved", { binId: bin, itemId: id, resolved });
  res.json({ message: "Updated", binId: bin, itemId: id });
});

// --------------------------------------------------
// EXPORT FULL AUDIT (includes Expected Bin + Status etc.)
// --------------------------------------------------
app.get("/export-summary", (req, res) => {
  const rows = [
    [
      "Bin ID","Auditor","# Items","Start Time","Item ID",
      "Expected Bin","Scanned Bin","WH Received",
      "Shappi Status","Audit Status","Resolved","Scan Timestamp"
    ]
  ];

  for (const [binId, audit] of Object.entries(audits)) {
    audit.items.forEach(i => {
      const inv = inventoryMap[i.itemId] || {};

      rows.push([
        binId,
        audit.auditor,
        audit.items.length,
        audit.startTime || "-",
        i.itemId,
        i.expectedBin,
        i.scannedBin,
        inv["received at warehouse"] || "",
        inv["status"] || "",
        i.status,
        i.resolved ? "Yes" : "No",
        i.ts
      ]);
    });
  }

  const csvContent = rows
    .map(r =>
      r.map(v => {
        const s = (v ?? "").toString();
        return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    )
    .join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_full_audit_${Date.now()}.csv`);
  res.send(csvContent);
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
io.on("connection", () => {});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

