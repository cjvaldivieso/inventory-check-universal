// server.js – Shappi Inventory App (stable CSV version)

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import fs from "fs";
import path from "path";
import csv from "csv-parser";
import moment from "moment-timezone";

const __dirname = process.cwd();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

const PORT = process.env.PORT || 10000;
const TZ = "America/New_York";

// -----------------------------
// Paths & basic setup
// -----------------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CSV_PATH = path.join(DATA_DIR, "items.csv");
const CSV_META_PATH = path.join(DATA_DIR, "csv-meta.json");
const AUDIT_PATH = path.join(DATA_DIR, "audit-log.json");

app.use(express.json());
app.use(express.static("public"));

// in-memory data
let csvRows = [];
let binSet = new Set();                  // all bin IDs found in CSV
let itemIndex = new Map();               // itemId -> row
let auditSessions = {};                  // binId -> { auditor, startTime, scans[] }
let csvMeta = { total: 0, uploadedAt: null };

// -----------------------------
// Helpers
// -----------------------------
function loadCsvFromDisk() {
  csvRows = [];
  binSet = new Set();
  itemIndex = new Map();

  if (!fs.existsSync(CSV_PATH)) {
    csvMeta = { total: 0, uploadedAt: null };
    return;
  }

  return new Promise((resolve, reject) => {
    fs.createReadStream(CSV_PATH)
      .pipe(csv())
      .on("data", (row) => {
        csvRows.push(row);
        const binId = (row["Warehouse Bin ID"] || "").trim().toUpperCase();
        const itemId = (row["Item ID"] || "").trim();
        if (binId) binSet.add(binId);
        if (itemId) itemIndex.set(itemId, row);
      })
      .on("end", () => {
        if (fs.existsSync(CSV_META_PATH)) {
          try {
            csvMeta = JSON.parse(fs.readFileSync(CSV_META_PATH, "utf8"));
          } catch {
            csvMeta = {
              total: csvRows.length,
              uploadedAt: moment().tz(TZ).format("YYYY-MM-DD HH:mm"),
            };
          }
        } else {
          csvMeta = {
            total: csvRows.length,
            uploadedAt: moment().tz(TZ).format("YYYY-MM-DD HH:mm"),
          };
        }
        console.log(`Loaded CSV with ${csvRows.length} rows`);
        resolve();
      })
      .on("error", (err) => reject(err));
  });
}

function saveAuditToDisk() {
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(auditSessions, null, 2));
}

function loadAuditFromDisk() {
  if (!fs.existsSync(AUDIT_PATH)) return;
  try {
    auditSessions = JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8"));
  } catch {
    auditSessions = {};
  }
}

// EST formatted time
function fmtEST(dateLike) {
  return moment(dateLike).tz(TZ).format("YYYY-MM-DD HH:mm");
}

// -----------------------------
// Initial load
// -----------------------------
await loadCsvFromDisk();
loadAuditFromDisk();

// -----------------------------
// Multer for CSV upload
// -----------------------------
const upload = multer({
  dest: DATA_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Upload CSV
app.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Move uploaded file to fixed path
    fs.renameSync(req.file.path, CSV_PATH);

    // Reload CSV into memory
    await loadCsvFromDisk();

    const uploadedAt = moment().tz(TZ).format("YYYY-MM-DD HH:mm");
    csvMeta = {
      total: csvRows.length,
      uploadedAt,
    };
    fs.writeFileSync(CSV_META_PATH, JSON.stringify(csvMeta, null, 2));

    // Notify all clients
    io.emit("csvUpdated", csvMeta);

    // Reset audits (optional – safer to avoid mixing CSV versions)
    auditSessions = {};
    saveAuditToDisk();

    res.json(csvMeta);
  } catch (err) {
    console.error("upload-csv error", err);
    res.status(500).json({ error: "Failed to upload CSV" });
  }
});

// Current CSV status
app.get("/csv-status", (req, res) => {
  res.json(csvMeta);
});

// -----------------------------
// Audit endpoints
// -----------------------------

// Start / update a bin audit
app.post("/audit/start/:binId", (req, res) => {
  if (!csvRows.length) {
    return res.status(400).json({ error: "no-csv" });
  }

  let binId = (req.params.binId || "").trim().toUpperCase();
  const auditor = (req.query.auditor || "Unknown").trim() || "Unknown";

  if (!/^[A-Z]{3}$/.test(binId)) {
    return res.status(400).json({ error: "bad-format" });
  }

  if (!binSet.has(binId)) {
    return res.status(400).json({ error: "no-bin" });
  }

  const now = new Date().toISOString();

  if (!auditSessions[binId]) {
    auditSessions[binId] = {
      auditor,
      startTime: now,
      scans: [],
    };
  } else {
    // If auditor changed, keep the first one, but we could update if you prefer.
    if (!auditSessions[binId].startTime) {
      auditSessions[binId].startTime = now;
    }
  }

  saveAuditToDisk();
  res.json({ ok: true });
});

// Scan an item
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body || {};
  const cleanBinId = (binId || "").trim().toUpperCase();
  const cleanItemId = (itemId || "").trim();

  if (!csvRows.length) {
    return res.status(400).json({ error: "no-csv" });
  }

  if (!cleanBinId || !cleanItemId) {
    return res.status(400).json({ error: "missing-fields" });
  }

  const row = itemIndex.get(cleanItemId);
  const nowIso = new Date().toISOString();

  let status = "no-bin";
  let auditStatus = "no-bin";
  let expectedBin = null;
  let record = {};

  if (row) {
    expectedBin = (row["Warehouse Bin ID"] || "").trim().toUpperCase();
    const shappiStatus = (row["status"] || "").trim();
    const category = row["category"] || "";
    const subcategory = row["Subcategory"] || "";
    const orderId = row["Order ID"] || "";
    const customer = row["customer"] || "";
    const whReceived = row["Received at Warehouse"] || "";

    // Decide audit status
    const sLower = shappiStatus.toLowerCase();

    if (
      sLower.includes("abandon") ||
      sLower.includes("cancel") ||
      sLower.includes("closed")
    ) {
      status = "remove-item";
      auditStatus = "remove-item";
    } else if (expectedBin && expectedBin === cleanBinId) {
      status = "match";
      auditStatus = "match";
    } else {
      status = "mismatch";
      auditStatus = "mismatch";
    }

    record = {
      expectedBin,
      received: whReceived,
      statusText: shappiStatus,
      category,
      subcategory,
      orderId,
      customer,
    };
  }

  // Save into audits
  if (!auditSessions[cleanBinId]) {
    auditSessions[cleanBinId] = {
      auditor: "Unknown",
      startTime: nowIso,
      scans: [],
    };
  }

  const session = auditSessions[cleanBinId];

  // One row per item per bin: update if exists
  const existing = session.scans.find((s) => s.itemId === cleanItemId);
  const scanRec = {
    itemId: cleanItemId,
    expectedBin: expectedBin || null,
    scannedBin: cleanBinId,
    whReceived: record.received || null,
    shappiStatus: record.statusText || null,
    auditStatus,
    resolved: false,
    scanTime: nowIso,
    orderId: record.orderId || null,
    category: record.category || null,
    subcategory: record.subcategory || null,
    customer: record.customer || null,
  };

  if (existing) {
    Object.assign(existing, scanRec);
  } else {
    session.scans.push(scanRec);
  }

  saveAuditToDisk();

  res.json({
    status,
    record,
  });
});

// Mark resolved (checkbox in UI)
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body || {};
  const cleanBinId = (binId || "").trim().toUpperCase();
  const cleanItemId = (itemId || "").trim();

  if (!auditSessions[cleanBinId]) return res.json({ ok: false });

  const session = auditSessions[cleanBinId];
  const rec = session.scans.find((s) => s.itemId === cleanItemId);
  if (rec) {
    rec.resolved = !!resolved;
    saveAuditToDisk();
  }

  res.json({ ok: true });
});

// -----------------------------
// Export full audit CSV
// -----------------------------
app.get("/export-full-audit", (req, res) => {
  if (!Object.keys(auditSessions).length) {
    return res.status(400).send("No audit data");
  }

  // Build summary per bin
  const binStats = {};
  for (const [binId, session] of Object.entries(auditSessions)) {
    const expectedTotal = csvRows.filter(
      (r) => (r["Warehouse Bin ID"] || "").trim().toUpperCase() === binId
    ).length;

    const uniqueItems = new Set(session.scans.map((s) => s.itemId));
    const matched = session.scans.filter((s) => s.auditStatus === "match")
      .length;
    const scanned = uniqueItems.size;
    const missing = Math.max(expectedTotal - matched, 0);

    binStats[binId] = { expectedTotal, scanned, matched, missing };
  }

  let lines = [];

  // Summary header
  lines.push("Bin ID,Expected Items,Scanned (unique),Matched,Missing");

  for (const [binId, stats] of Object.entries(binStats)) {
    lines.push(
      `${binId},${stats.expectedTotal},${stats.scanned},${stats.matched},${stats.missing}`
    );
  }

  // Blank line
  lines.push("");
  // Detail header (includes extra columns)
  lines.push(
    [
      "Bin ID",
      "Auditor",
      "# Items in Session",
      "Start Time (EST)",
      "Item ID",
      "Expected Bin",
      "Scanned Bin",
      "WH Received",
      "Shappi Status",
      "Audit Status",
      "Resolved",
      "Scan Timestamp (EST)",
      "Order ID",
      "Category",
      "Subcategory",
      "Customer",
    ].join(",")
  );

  // Detail rows
  for (const [binId, session] of Object.entries(auditSessions)) {
    const count = session.scans.length;
    const startTime = session.startTime
      ? fmtEST(session.startTime)
      : fmtEST(new Date().toISOString());

    for (const s of session.scans) {
      const scanTs = fmtEST(s.scanTime);
      lines.push(
        [
          binId,
          session.auditor || "Unknown",
          count,
          startTime,
          s.itemId,
          s.expectedBin || "",
          s.scannedBin || "",
          (s.whReceived || "").replace(/,/g, " "),
          (s.shappiStatus || "").replace(/,/g, " "),
          s.auditStatus || "",
          s.resolved ? "Yes" : "No",
          scanTs,
          s.orderId || "",
          (s.category || "").replace(/,/g, " "),
          (s.subcategory || "").replace(/,/g, " "),
          (s.customer || "").replace(/,/g, " "),
        ].join(",")
      );
    }
  }

  const csvContent = lines.join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="shappi_full_audit_${Date.now()}.csv"`
  );
  res.send(csvContent);
});

// -----------------------------
// Socket.io basic connection
// -----------------------------
io.on("connection", (socket) => {
  console.log("Client connected");
  if (csvMeta.total) {
    socket.emit("csvUpdated", csvMeta);
  }
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`Shappi Inventory Backend running on ${PORT}`);
});

