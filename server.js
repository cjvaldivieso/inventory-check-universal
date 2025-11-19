// server.js — Shappi WH Inventory Backend v4.1

import express from "express";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import path from "path";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import moment from "moment-timezone";

const __dirname = process.cwd();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// -----------------------
// BASIC MIDDLEWARE
// -----------------------
app.use(cors());
app.use(express.json());

// No-cache for front-end assets
app.use(
  express.static("public", {
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith(".html") ||
        filePath.endsWith(".js")   ||
        filePath.endsWith(".css")
      ) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    }
  })
);

// -----------------------
// PERSISTED META STORAGE
// -----------------------
const DATA_DIR       = path.join(__dirname, "data");
const CSV_META_FILE  = path.join(DATA_DIR, "csv-meta.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// -----------------------
// IN-MEMORY STATE
// -----------------------
let inventoryData = [];    // full row objects
let inventoryMap  = {};    // itemId -> record
let binSet        = new Set(); // set of valid bin IDs
let audits        = {};    // binId -> { auditor, startTime, endTime, items: [...] }

// items in audit:
// { itemId, expectedBin, scannedBin, status, resolved, ts }

const upload = multer({ dest: "uploads/" });

// -----------------------
// CSV UPLOAD
// -----------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const uploadTimeEST = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {
      const normalized = {};
      for (const key in row) {
        const cleanKey = key.trim().toLowerCase();
        normalized[cleanKey] = (row[key] || "").toString().trim();
      }
      rows.push(normalized);
    })
    .on("end", () => {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      inventoryData = rows;
      inventoryMap  = {};
      binSet        = new Set();

      for (const record of rows) {
        const itemId = (record["item id"] || "").trim().toUpperCase();
        const bin    = (record["warehouse bin id"] || "").trim().toUpperCase();
        if (itemId) inventoryMap[itemId] = record;
        if (bin)    binSet.add(bin);
      }

      // Persist CSV meta so new dynos / users see same timestamp
      try {
        fs.writeFileSync(
          CSV_META_FILE,
          JSON.stringify(
            {
              uploadedAt: uploadTimeEST,
              total: rows.length
            },
            null,
            2
          )
        );
      } catch (err) {
        console.error("Failed to write CSV meta file", err);
      }

      // Broadcast to all connected clients
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

// -----------------------
// CSV STATUS
// -----------------------
app.get("/csv-status", (req, res) => {
  try {
    if (fs.existsSync(CSV_META_FILE)) {
      const raw  = fs.readFileSync(CSV_META_FILE, "utf8");
      const meta = JSON.parse(raw);
      return res.json({
        total: meta.total ?? inventoryData.length,
        uploadedAt: meta.uploadedAt ?? null
      });
    }
  } catch (err) {
    console.error("Failed to read CSV meta file", err);
  }

  // Fallback if file missing
  res.json({
    total: inventoryData.length,
    uploadedAt: null
  });
});

// -----------------------
// AUDIT START
// -----------------------
app.post("/audit/start/:binId", (req, res) => {
  const rawBin = (req.params.binId || "").toString().trim().toUpperCase();
  const auditor = (req.query.auditor || "Unknown").toString();

  // Client-side should already enforce 3 letters, but double-check here
  if (!/^[A-Z]{3}$/.test(rawBin)) {
    return res.status(400).json({ error: "Bin must be a 3-letter code" });
  }

  if (!inventoryData.length) {
    return res.status(400).json({ error: "No CSV loaded yet" });
  }

  if (!binSet.has(rawBin)) {
    return res.status(400).json({ error: "Invalid bin — not found in CSV" });
  }

  audits[rawBin] = {
    auditor,
    startTime: new Date().toISOString(),
    endTime: null,
    items: []
  };

  io.emit("auditStarted", {
    binId: rawBin,
    auditor,
    startTime: audits[rawBin].startTime
  });

  res.json({ message: `Audit started for ${rawBin}`, auditor });
});

// -----------------------
// ITEM SCAN
// -----------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body || {};
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId)  return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  const bin = String(binId).trim().toUpperCase();
  const id  = String(itemId).trim().toUpperCase();

  if (!audits[bin]) {
    return res.status(400).json({ error: "Bin not active. Scan Bin QR first." });
  }
  if (!inventoryData.length) {
    return res.status(400).json({ error: "No CSV loaded" });
  }

  const record = inventoryMap[id];
  let status   = "match";
  let expected = "-";

  if (!record) {
    status = "no-bin";
  } else {
    expected = (record["warehouse bin id"] || "").trim().toUpperCase();

    const statusText = (record["status"] || "").toLowerCase();
    const closedish  =
      statusText.includes("shappi closed")  ||
      statusText.includes("shappi canceled") ||
      statusText.includes("abandoned");

    if (closedish) {
      status = "remove-item";
    } else if (expected !== bin) {
      status = "mismatch";
    } else {
      status = "match";
    }
  }

  const itemRec = {
    itemId: id,
    expectedBin: expected,
    scannedBin: bin,
    status,
    resolved: false,
    ts: new Date().toISOString()
  };

  // Prepend in case we later want "most recent first"
  audits[bin].items.unshift(itemRec);

  io.emit("itemScanned", { binId: bin, auditor, item: itemRec });

  return res.json({
    status,
    correctBin: expected !== "-" ? expected : null,
    record: record
      ? {
          itemId: id,
          binId: bin,
          received:   record["received at warehouse"] || "",
          statusText: record["status"] || "",
          category:   record["category"] || "",
          subcategory: record["subcategory"] || ""
        }
      : null
  });
});

// -----------------------
// RESOLUTION TOGGLE
// -----------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body || {};
  if (!binId || !itemId) {
    return res.status(400).json({ error: "Missing binId or itemId" });
  }

  const bin = String(binId).trim().toUpperCase();
  const id  = String(itemId).trim().toUpperCase();

  const audit = audits[bin];
  if (!audit) {
    return res.status(404).json({ error: "Audit not found for bin" });
  }

  const itm = audit.items.find(i => i.itemId === id);
  if (!itm) {
    return res.status(404).json({ error: "Item not found in audit" });
  }

  itm.resolved = !!resolved;

  io.emit("itemResolved", {
    binId: bin,
    itemId: id,
    resolved: !!resolved
  });

  res.json({ message: "Updated", binId: bin, itemId: id, resolved: !!resolved });
});

// -----------------------
// END AUDIT
// -----------------------
app.post("/audit/end/:binId", (req, res) => {
  const rawBin = (req.params.binId || "").toString().trim().toUpperCase();
  const audit  = audits[rawBin];

  if (!audit) {
    return res.status(404).json({ error: "No active audit for this bin" });
  }

  audit.endTime = new Date().toISOString();

  io.emit("auditEnded", {
    binId: rawBin,
    endTime: audit.endTime,
    audit
  });

  res.json({ message: `Audit completed for ${rawBin}` });
});

// -----------------------
// EXPORT SUMMARY CSV
// -----------------------
app.get("/export-summary", (req, res) => {
  const binIds = Object.keys(audits);
  if (!binIds.length) {
    return res.status(400).json({ error: "No audits to export" });
  }

  const rows = [
    [
      "Bin ID",
      "Auditor",
      "Status",
      "# Items",
      "Accuracy %",
      "Start Time",
      "End Time",
      "Item ID",
      "Expected Bin",
      "Scanned Bin",
      "Item Status",
      "Resolved",
      "Scan Timestamp"
    ]
  ];

  for (const binId of binIds) {
    const audit = audits[binId];
    const total   = audit.items.length;
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
        audit.endTime  || "-",
        i.itemId,
        i.expectedBin,
        i.scannedBin,
        i.status,
        i.resolved ? "Yes" : "No",
        i.ts
      ]);
    });
  }

  const csvContent = rows
    .map(r =>
      r
        .map(v => {
          const s = (v ?? "").toString();
          return s.includes(",") || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(",")
    )
    .join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_summary_${Date.now()}.csv`);
  res.send(csvContent);
});

// -----------------------
// SERVER START
// -----------------------
io.on("connection", () => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Shappi Inventory Backend v4.1 running on ${PORT}`);
});

