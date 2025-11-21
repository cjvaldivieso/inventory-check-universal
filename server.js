// server.js — Shappi Inventory Backend (stable CSV + scan + exports)

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import multer from "multer";
import csv from "csv-parser";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// -------------------------------------------------------------
// Directories
// -------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const CANONICAL_CSV = path.join(DATA_DIR, "latest.csv");
const META_PATH = path.join(DATA_DIR, "csv-meta.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer for CSV uploads
const upload = multer({ dest: UPLOADS_DIR });

// JSON body parser for scan routes
app.use(express.json());

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------
// In-memory state
// -------------------------------------------------------------
let items = [];                // raw CSV rows
let itemsById = new Map();     // normalized Item ID -> row
let binsSet = new Set();       // normalized Bin ID
let audits = [];               // list of scan results
let csvMeta = { total: 0, uploadedAt: null };

// Normalizers (match CSV + scanner input safely)
const normalizeId = (v) => String(v ?? "").trim();
const normalizeBin = (v) => String(v ?? "").trim().toUpperCase();

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function rebuildIndexes(rows) {
  items = rows;
  itemsById = new Map();
  binsSet = new Set();
  audits = []; // reset audits when a new CSV is uploaded

  for (const row of rows) {
    const itemId = normalizeId(row["Item ID"]);
    const binId = normalizeBin(row["Warehouse Bin ID"]);

    if (itemId) itemsById.set(itemId, row);
    if (binId) binsSet.add(binId);
  }

  csvMeta.total = items.length;
}

function loadCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function initFromDisk() {
  try {
    if (fs.existsSync(CANONICAL_CSV)) {
      const rows = await loadCsvFile(CANONICAL_CSV);
      rebuildIndexes(rows);
    }

    if (fs.existsSync(META_PATH)) {
      const metaRaw = fs.readFileSync(META_PATH, "utf8");
      csvMeta = { ...csvMeta, ...JSON.parse(metaRaw) };
    }
  } catch (err) {
    console.error("Failed to init from disk:", err);
  }
}

initFromDisk();

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

// CSV status (for showing "CSV Loaded" + timestamp)
app.get("/csv-status", (req, res) => {
  res.json(csvMeta);
});

// Upload CSV
app.post("/upload-csv", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "no-file" });
  }

  try {
    const rows = await loadCsvFile(req.file.path);
    rebuildIndexes(rows);

    // Save canonical copy + metadata so restarts still know the latest CSV
    fs.copyFileSync(req.file.path, CANONICAL_CSV);
    csvMeta.uploadedAt = new Date().toISOString();
    fs.writeFileSync(META_PATH, JSON.stringify(csvMeta, null, 2));

    res.json({
      ok: true,
      total: csvMeta.total,
      uploadedAt: csvMeta.uploadedAt,
    });
  } catch (err) {
    console.error("CSV upload parse error:", err);
    res.status(500).json({ ok: false, error: "parse-failed" });
  }
});

// Scan Bin — validate that the bin exists in the CSV
app.post("/scan-bin", (req, res) => {
  const rawBin = req.body?.binId;
  const binId = normalizeBin(rawBin);

  if (!binId) {
    return res.status(400).json({ ok: false, error: "missing-bin" });
  }

  if (!csvMeta.total || binsSet.size === 0) {
    return res.json({ ok: false, error: "no-csv" });
  }

  if (!binsSet.has(binId)) {
    return res.json({ ok: false, error: "invalid-bin", binId });
  }

  res.json({ ok: true, binId });
});

// Scan Item — compare against CSV and record audit entry
app.post("/scan-item", (req, res) => {
  const binId = normalizeBin(req.body?.binId);
  const itemId = normalizeId(req.body?.itemId);

  if (!binId || !itemId) {
    return res.status(400).json({ ok: false, error: "missing-fields" });
  }

  if (!csvMeta.total || binsSet.size === 0) {
    return res.json({ ok: false, error: "no-csv" });
  }

  const row = itemsById.get(itemId);
  let auditStatus = "";
  let expectedBin = "";
  let whReceived = "";
  let shappiStatus = "";
  let category = "";
  let subcategory = "";
  let customer = "";

  if (!row) {
    auditStatus = "not-in-csv";
  } else {
    expectedBin = normalizeBin(row["Warehouse Bin ID"]);
    whReceived = row["Received at Warehouse"] || "";
    shappiStatus = row["status"] || "";
    category = row["category"] || "";
    subcategory = row["Subcategory"] || "";
    customer = row["customer"] || "";

    if (!expectedBin) {
      auditStatus = "no-bin";
    } else if (expectedBin === binId) {
      auditStatus = "match";
    } else {
      auditStatus = "mismatch";
    }
  }

  const auditRecord = {
    binId,
    itemId,
    expectedBin,
    scannedBin: binId,
    whReceived,
    shappiStatus,
    category,
    subcategory,
    customer,
    auditStatus,
    timestamp: new Date().toISOString(),
  };

  audits.push(auditRecord);

  res.json({
    ok: true,
    status: auditStatus,
    audit: auditRecord,
  });
});

// Export full audit as CSV
app.get("/export-full-audit", (req, res) => {
  if (!audits.length) {
    return res.status(400).send("No audit data yet.");
  }

  const header = [
    "Bin ID",
    "Item ID",
    "Expected Bin",
    "Scanned Bin",
    "WH Received",
    "Shappi Status",
    "Audit Status",
    "Category",
    "Subcategory",
    "Customer",
    "Scan Timestamp",
  ];

  const lines = [header.join(",")];

  for (const a of audits) {
    const cells = [
      a.binId,
      a.itemId,
      a.expectedBin,
      a.scannedBin,
      a.whReceived,
      a.shappiStatus,
      a.auditStatus,
      a.category,
      a.subcategory,
      a.customer,
      a.timestamp,
    ].map((v) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`
    );

    lines.push(cells.join(","));
  }

  const csvText = lines.join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="shappi_full_audit_${Date.now()}.csv"`
  );
  res.send(csvText);
});

// Fallback: serve index.html for any unknown route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------------------------------------------------
// Start server
// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Shappi Inventory Backend running on ${PORT}`);
});

