// server.js — Shappi WH Inventory App v4.0
// Backend: CSV upload, audit logic, export, bin validation

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

// -------------------------
// Basic middleware
// -------------------------
app.use(cors());
app.use(express.json());

// Serve static assets with no-cache headers for HTML/JS/CSS
app.use(
  express.static("public", {
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith(".html") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".css")
      ) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate"
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  })
);

// Ensure folders exist (for uploads + meta)
fs.mkdirSync("uploads", { recursive: true });
fs.mkdirSync("data", { recursive: true });

// -------------------------
// Global in-memory state
// -------------------------
let inventoryData = [];        // raw normalized rows
let inventoryMap = {};         // by ITEM ID
let binSet = new Set();        // all Bin IDs in CSV
let lastCsvTimestamp = null;   // EST string
let lastCsvTotal = 0;          // # rows

// audits[binId] = { auditor, startTime, endTime, items: [...] }
let audits = {};

const upload = multer({ dest: "uploads/" });

// ------------- helpers -------------
const META_PATH = "data/csv-meta.json";

function saveCsvMetaToDisk() {
  const meta = {
    total: lastCsvTotal,
    uploadedAt: lastCsvTimestamp,
    bins: [...binSet],
  };
  try {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to write CSV meta:", err);
  }
}

function loadCsvMetaFromDisk() {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    const raw = fs.readFileSync(META_PATH, "utf8");
    const meta = JSON.parse(raw);
    if (meta.uploadedAt) lastCsvTimestamp = meta.uploadedAt;
    if (typeof meta.total === "number") lastCsvTotal = meta.total;
    if (Array.isArray(meta.bins)) binSet = new Set(meta.bins);
    return meta;
  } catch (err) {
    console.error("Failed to read CSV meta:", err);
    return null;
  }
}

// Load meta (if any) at boot so /csv-status has something
loadCsvMetaFromDisk();

// -------------------------
// CSV upload
// -------------------------
app.post("/upload-csv", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const uploadTimeEST = moment()
    .tz("America/New_York")
    .format("MM/DD/YYYY hh:mm A");

  const rows = [];
  const newBinSet = new Set();

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => {
      const normalized = {};
      for (const key in d) {
        const cleanKey = (key || "").trim().toLowerCase();
        normalized[cleanKey] = (d[key] || "").trim();
      }
      rows.push(normalized);

      const bin = (normalized["warehouse bin id"] || "").trim().toUpperCase();
      if (bin) newBinSet.add(bin);
    })
    .on("end", () => {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }

      inventoryData = rows;
      inventoryMap = {};
      rows.forEach((record) => {
        const itemId = (record["item id"] || "").trim().toUpperCase();
        if (itemId) inventoryMap[itemId] = record;
      });

      binSet = newBinSet;
      lastCsvTotal = rows.length;
      lastCsvTimestamp = uploadTimeEST;

      // Save meta for future /csv-status
      saveCsvMetaToDisk();

      // Notify all clients
      io.emit("csvUpdated", {
        message: "CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST,
      });

      res.json({
        message: "CSV uploaded successfully",
        total: rows.length,
        uploadedAt: uploadTimeEST,
      });
    })
    .on("error", (err) => {
      console.error("CSV parse error:", err);
      res.status(500).json({ error: "CSV parsing failed" });
    });
});

// -------------------------
// CSV status
// -------------------------
app.get("/csv-status", (req, res) => {
  if (!lastCsvTimestamp || !lastCsvTotal) {
    const meta = loadCsvMetaFromDisk(); // may set globals
    if (!meta) {
      return res.json({ total: 0, uploadedAt: null });
    }
    return res.json({ total: meta.total || 0, uploadedAt: meta.uploadedAt });
  }

  res.json({ total: lastCsvTotal, uploadedAt: lastCsvTimestamp });
});

// -------------------------
// AUDIT: start
// -------------------------
app.post("/audit/start/:binId", (req, res) => {
  let { binId } = req.params;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!inventoryData.length) {
    return res.status(400).json({ error: "No CSV loaded" });
  }

  binId = (binId || "").trim().toUpperCase();

  // 3-letter alpha validation
  if (!/^[A-Z]{3}$/.test(binId)) {
    return res.status(400).json({
      error: "Invalid bin format. Use 3 letters like KCM.",
    });
  }

  // Must exist in CSV
  if (!binSet.has(binId)) {
    return res.status(400).json({
      error: "Invalid bin. Bin does not exist in current CSV.",
    });
  }

  const startTime = new Date().toISOString();

  audits[binId] = {
    auditor,
    startTime,
    endTime: null,
    items: [], // each: { itemId, expectedBin, scannedBin, status, resolved, ts }
  };

  io.emit("auditStarted", { binId, auditor, startTime });
  res.json({ message: `Audit started for ${binId}`, auditor });
});

// -------------------------
// AUDIT: scan item
// -------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId) return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });
  if (!audits[binId])
    return res
      .status(400)
      .json({ error: "Bin not active. Scan Bin QR first." });
  if (!inventoryData.length)
    return res.status(400).json({ error: "No CSV loaded" });

  const normalizedItemId = (itemId || "").trim().toUpperCase();
  const record = inventoryMap[normalizedItemId];

  let status = "match";
  let expectedBin = "-";

  if (!record) {
    status = "no-bin";
  } else {
    expectedBin = (record["warehouse bin id"] || "").trim().toUpperCase();
    const statusText = (record["status"] || "").toLowerCase();

    if (
      statusText === "shappi closed" ||
      statusText === "abandoned" ||
      statusText === "shappi canceled"
    ) {
      status = "remove-item";
    } else if (expectedBin !== binId.trim().toUpperCase()) {
      status = "mismatch";
    }
  }

  const ts = new Date().toISOString();
  const binAudit = audits[binId];

  // Upsert item in audit (unique per bin)
  let existing = binAudit.items.find((i) => i.itemId === itemId);
  if (existing) {
    existing.expectedBin = expectedBin;
    existing.scannedBin = binId;
    existing.status = status;
    existing.ts = ts;
  } else {
    existing = {
      itemId,
      expectedBin,
      scannedBin: binId,
      status,
      resolved: false,
      ts,
    };
    binAudit.items.unshift(existing);
  }

  io.emit("itemScanned", { binId, auditor, item: existing });

  return res.json({
    status,
    correctBin: expectedBin !== "-" ? expectedBin : null,
    record: record
      ? {
          itemId,
          binId,
          received: record["received at warehouse"] || "",
          statusText: record["status"] || "",
          category: record["category"] || "",
          subcategory: record["subcategory"] || "",
        }
      : null,
  });
});

// -------------------------
// AUDIT: resolve mismatch
// -------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;
  if (!binId || !itemId) {
    return res.status(400).json({ error: "Missing binId or itemId" });
  }

  const audit = audits[binId];
  if (!audit) return res.status(404).json({ error: "Audit not found" });

  const itm = audit.items.find((i) => i.itemId === itemId);
  if (!itm) return res.status(404).json({ error: "Item not found in audit" });

  itm.resolved = !!resolved;
  io.emit("itemResolved", { binId, itemId, resolved: !!resolved });
  res.json({ message: "Updated", binId, itemId, resolved: !!resolved });
});

// -------------------------
// AUDIT: end
// -------------------------
app.post("/audit/end/:binId", (req, res) => {
  const { binId } = req.params;
  const audit = audits[binId];

  if (!audit) return res.status(404).json({ error: "No active audit for bin" });

  audit.endTime = new Date().toISOString();
  io.emit("auditEnded", { binId, endTime: audit.endTime, audit });
  res.json({ message: `Audit completed for ${binId}` });
});

// -------------------------
// EXPORT SUMMARY (full audit)
// -------------------------
app.get("/export-summary", (req, res) => {
  if (!Object.keys(audits).length) {
    return res.status(400).json({ error: "No audits to export" });
  }

  const rows = [
    [
      "Bin ID",
      "Auditor",
      "Status",
      "# Unique Items",
      "Accuracy %",
      "Start Time",
      "End Time",
      "Item ID",
      "Expected Bin",
      "Scanned Bin",
      "Item Status",
      "Resolved",
      "Scan Timestamp",
    ],
  ];

  for (const [binId, audit] of Object.entries(audits)) {
    const uniqueItems = audit.items.length;
    const correct = audit.items.filter((i) => i.status === "match").length;
    const accuracy = uniqueItems ? Math.round((correct / uniqueItems) * 100) : 0;
    const statusLabel = audit.endTime ? "Completed" : "In Progress";

    audit.items.forEach((i) => {
      rows.push([
        binId,
        audit.auditor,
        statusLabel,
        uniqueItems,
        accuracy,
        audit.startTime || "-",
        audit.endTime || "-",
        i.itemId,
        i.expectedBin,
        i.scannedBin,
        i.status,
        i.resolved ? "Yes" : "No",
        i.ts,
      ]);
    });
  }

  const csvContent = rows
    .map((r) =>
      r
        .map((v) => {
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

// -------------------------
// Start server
// -------------------------
io.on("connection", () => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Shappi Inventory Backend v4.0 running on ${PORT}`)
);

