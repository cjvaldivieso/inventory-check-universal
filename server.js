import express from "express";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import path from "path";
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
app.use(
  express.static("public", {
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith(".html") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".css")
      ) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  })
);

// --------------------------------------------------
// GLOBAL STATE (CSV)
// --------------------------------------------------
let inventoryData = [];
let inventoryMap = {}; // ITEM ID → record
let lastCsvTimestamp = null;

const upload = multer({ dest: "uploads/" });

// Helper: format timestamps in EST as MM/DD/YYYY hh:mm AM/PM
function formatEST(ts) {
  if (!ts) return "";
  return moment(ts).tz("America/New_York").format("MM/DD/YYYY hh:mm A");
}

// --------------------------------------------------
// AUDIT PERSISTENCE (JSON on disk)
// --------------------------------------------------
const DATA_DIR = path.join(process.cwd(), "data");
const AUDIT_STORE_PATH = path.join(DATA_DIR, "audits.json");

// Store format:
// {
//   audits: { [auditId]: { auditId, binId, auditor, startTime, endTime, status, lastActivity, items: [] } },
//   activeByBin: { [binId]: auditId }
// }
let auditStore = {
  audits: {},
  activeByBin: {},
};

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed creating data dir:", e);
  }
}

function loadAuditStore() {
  ensureDataDir();
  try {
    if (fs.existsSync(AUDIT_STORE_PATH)) {
      const raw = fs.readFileSync(AUDIT_STORE_PATH, "utf8");
      const parsed = JSON.parse(raw || "{}");
      auditStore = {
        audits: parsed.audits || {},
        activeByBin: parsed.activeByBin || {},
      };
      console.log(
        `✅ Loaded audit store: ${Object.keys(auditStore.audits).length} audits`
      );
    }
  } catch (e) {
    console.error("Failed loading audit store:", e);
  }
}

let saveTimer = null;
function saveAuditStoreDebounced() {
  ensureDataDir();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(AUDIT_STORE_PATH, JSON.stringify(auditStore, null, 2));
    } catch (e) {
      console.error("Failed saving audit store:", e);
    }
  }, 250);
}

function getActiveAuditForBin(binId) {
  const bin = (binId || "").toUpperCase();
  const auditId = auditStore.activeByBin[bin];
  if (!auditId) return null;
  return auditStore.audits[auditId] || null;
}

function getLastActivityTs(audit) {
  if (!audit) return 0;
  const t = audit.lastActivity || audit.endTime || audit.startTime;
  return t ? new Date(t).getTime() : 0;
}

function pickLatestAudit() {
  const audits = Object.values(auditStore.audits);
  if (!audits.length) return null;
  audits.sort((a, b) => getLastActivityTs(b) - getLastActivityTs(a));
  return audits[0];
}

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
      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      inventoryData = rows;
      inventoryMap = {};
      lastCsvTimestamp = uploadTime;

      for (const row of rows) {
        const id = (row["item id"] || "").toUpperCase();
        if (id) inventoryMap[id] = row;
      }

      io.emit("csvUpdated", {
        total: rows.length,
        uploadedAt: uploadTime,
      });

      res.json({
        message: "CSV uploaded",
        total: rows.length,
        uploadedAt: uploadTime,
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
    uploadedAt: lastCsvTimestamp,
  });
});

// --------------------------------------------------
// BIN VALIDATION ENDPOINT
// --------------------------------------------------
app.get("/validate-bin/:binId", (req, res) => {
  const bin = req.params.binId.toUpperCase();

  const valid = inventoryData.some(
    (row) => (row["warehouse bin id"] || "").toUpperCase() === bin
  );

  res.json({ valid });
});

// --------------------------------------------------
// START AUDIT FOR BIN (PERSISTED)
// --------------------------------------------------
app.post("/audit/start/:binId", (req, res) => {
  const binId = req.params.binId.toUpperCase();
  const auditor = (req.query.auditor || "Unknown").toString();

  // If there's already an active audit for this bin, reuse it (don’t overwrite)
  const existing = getActiveAuditForBin(binId);
  if (existing) {
    existing.lastActivity = new Date().toISOString();
    saveAuditStoreDebounced();
    io.emit("auditStarted", { binId, auditor: existing.auditor });
    return res.json({
      message: `Audit already active for ${binId}`,
      auditor: existing.auditor,
      auditId: existing.auditId,
    });
  }

  const auditId = `${binId}-${Date.now()}`;
  const now = new Date().toISOString();

  auditStore.audits[auditId] = {
    auditId,
    binId,
    auditor,
    startTime: now,
    endTime: null,
    status: "active",
    lastActivity: now,
    items: [],
  };

  auditStore.activeByBin[binId] = auditId;
  saveAuditStoreDebounced();

  io.emit("auditStarted", { binId, auditor });
  res.json({ message: `Audit started for ${binId}`, auditor, auditId });
});

// --------------------------------------------------
// OPTIONAL: FINISH AUDIT (so you can export later confidently)
// --------------------------------------------------
app.post("/audit/finish/:binId", (req, res) => {
  const binId = req.params.binId.toUpperCase();
  const audit = getActiveAuditForBin(binId);

  if (!audit) return res.status(404).json({ error: "No active audit for bin" });

  audit.status = "completed";
  audit.endTime = new Date().toISOString();
  audit.lastActivity = audit.endTime;

  delete auditStore.activeByBin[binId];
  saveAuditStoreDebounced();

  io.emit("auditFinished", { binId, auditId: audit.auditId });
  res.json({ message: "Audit finished", binId, auditId: audit.auditId });
});

// --------------------------------------------------
// SCAN ITEM (PERSISTED)
// --------------------------------------------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = (req.query.auditor || "Unknown").toString();

  if (!binId) return res.status(400).json({ error: "Missing binId" });
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  const bin = binId.toUpperCase();
  const id = itemId.toUpperCase();

  const audit = getActiveAuditForBin(bin);
  if (!audit) {
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
    ts: new Date().toISOString(),
  };

  audit.items.unshift(auditEntry);
  audit.lastActivity = auditEntry.ts;
  saveAuditStoreDebounced();

  io.emit("itemScanned", { binId: bin, auditor, item: auditEntry });

  res.json({
    status,
    correctBin: expectedBin !== "-" ? expectedBin : null,
    record: record
      ? {
          expectedBin,
          received: record["received at warehouse"] || "",
          statusText: record["status"] || "",
        }
      : null,
  });
});

// --------------------------------------------------
// RESOLVE MOVE (PERSISTED)
// --------------------------------------------------
app.post("/audit/resolve", (req, res) => {
  const { binId, itemId, resolved } = req.body;
  const bin = (binId || "").toUpperCase();
  const id = (itemId || "").toUpperCase();

  const audit = getActiveAuditForBin(bin);
  if (!audit) return res.status(404).json({ error: "Audit not found" });

  const row = audit.items.find((i) => i.itemId === id);
  if (!row) return res.status(404).json({ error: "Item not found in audit" });

  row.resolved = !!resolved;
  audit.lastActivity = new Date().toISOString();
  saveAuditStoreDebounced();

  io.emit("itemResolved", { binId: bin, itemId: id, resolved: !!resolved });
  res.json({ message: "Updated", binId: bin, itemId: id });
});

// --------------------------------------------------
// AUDIT HISTORY (so you can export later)
// --------------------------------------------------
app.get("/audit-history", (req, res) => {
  const list = Object.values(auditStore.audits)
    .sort((a, b) => getLastActivityTs(b) - getLastActivityTs(a))
    .slice(0, 50)
    .map((a) => ({
      auditId: a.auditId,
      binId: a.binId,
      auditor: a.auditor,
      status: a.status,
      startTime: formatEST(a.startTime),
      endTime: formatEST(a.endTime),
      lastActivity: formatEST(a.lastActivity),
      scannedCount: a.items?.length || 0,
    }));

  res.json({ audits: list });
});

// --------------------------------------------------
// EXPORT HELPERS (generate CSV from ONE audit)
// --------------------------------------------------
function auditToCsvRows(audit) {
  const rows = [];

  rows.push(["AUDIT"]);
  rows.push(["Audit ID", audit.auditId]);
  rows.push(["Bin ID", audit.binId]);
  rows.push(["Auditor", audit.auditor]);
  rows.push(["Status", audit.status]);
  rows.push(["Start Time", formatEST(audit.startTime)]);
  rows.push(["End Time", formatEST(audit.endTime)]);
  rows.push(["Last Activity", formatEST(audit.lastActivity)]);
  rows.push([]);

  rows.push([
    "Item ID",
    "Expected Bin",
    "Scanned Bin",
    "WH Received",
    "Shappi Status",
    "Audit Status",
    "Resolved",
    "Scan Timestamp",
    "Order ID",
    "Category",
    "Subcategory",
    "Customer",
  ]);

  for (const i of audit.items || []) {
    const inv = inventoryMap[i.itemId] || {};
    rows.push([
      i.itemId,
      i.expectedBin || "",
      i.scannedBin || "",
      inv["received at warehouse"] || "",
      inv["status"] || "",
      i.status || "",
      i.resolved ? "Yes" : "No",
      formatEST(i.ts),
      inv["order id"] || "",
      inv["category"] || "",
      inv["subcategory"] || "",
      inv["customer"] || "",
    ]);
  }

  return rows;
}

function rowsToCsv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = (v ?? "").toString();
          return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    )
    .join("\n");
}

// --------------------------------------------------
// EXPORT LATEST AUDIT (works even if you weren’t online)
// --------------------------------------------------
app.get("/export-latest", (req, res) => {
  const latest = pickLatestAudit();
  if (!latest) return res.status(404).send("No audits found");

  const csvContent = rowsToCsv(auditToCsvRows(latest));
  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_${latest.binId}_${Date.now()}.csv`);
  res.send(csvContent);
});

// --------------------------------------------------
// EXPORT A SPECIFIC AUDIT ID
// --------------------------------------------------
app.get("/export-audit/:auditId", (req, res) => {
  const auditId = req.params.auditId;
  const audit = auditStore.audits[auditId];
  if (!audit) return res.status(404).send("Audit not found");

  const csvContent = rowsToCsv(auditToCsvRows(audit));
  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_audit_${audit.binId}_${Date.now()}.csv`);
  res.send(csvContent);
});

// --------------------------------------------------
// KEEP YOUR EXISTING FULL EXPORT (ALL BINS) — NOW FROM STORED AUDITS
// --------------------------------------------------
app.get("/export-summary", (req, res) => {
  const rows = [];

  // 1) BIN SUMMARY HEADER
  rows.push(["BIN SUMMARY"]);
  rows.push(["Bin ID", "Expected Items", "Scanned Items", "Missing Items", "Missing Item IDs"]);

  // Build summary per bin (for bins that have an audit)
  const audits = Object.values(auditStore.audits);

  for (const audit of audits) {
    const binId = (audit.binId || "").toUpperCase();
    if (!binId) continue;

    // All expected items in this bin (from CSV)
    const expectedSet = new Set(
      inventoryData
        .filter((row) => (row["warehouse bin id"] || "").toUpperCase() === binId)
        .map((row) => (row["item id"] || "").toUpperCase())
        .filter(Boolean)
    );

    // Items from expectedSet that were scanned
    const scannedExpected = new Set(
      (audit.items || []).map((i) => i.itemId).filter((id) => expectedSet.has(id))
    );

    const missingIds = [...expectedSet].filter((id) => !scannedExpected.has(id));

    rows.push([
      binId,
      expectedSet.size,
      scannedExpected.size,
      missingIds.length,
      missingIds.join(" "),
    ]);
  }

  // Blank line between summary and detail
  rows.push([]);
  rows.push(["FULL AUDIT DETAILS"]);

  // 2) FULL ITEM-LEVEL DETAILS HEADER
  rows.push([
    "Audit ID",
    "Bin ID",
    "Auditor",
    "# Items",
    "Start Time",
    "End Time",
    "Item ID",
    "Expected Bin",
    "Scanned Bin",
    "WH Received",
    "Shappi Status",
    "Audit Status",
    "Resolved",
    "Scan Timestamp",
    "Order ID",
    "Category",
    "Subcategory",
    "Customer",
  ]);

  // 3) ITEM-LEVEL ROWS
  for (const audit of audits) {
    const totalItems = audit.items?.length || 0;

    (audit.items || []).forEach((i) => {
      const inv = inventoryMap[i.itemId] || {};
      rows.push([
        audit.auditId,
        audit.binId,
        audit.auditor,
        totalItems,
        formatEST(audit.startTime),
        formatEST(audit.endTime),
        i.itemId,
        i.expectedBin || "",
        i.scannedBin || "",
        inv["received at warehouse"] || "",
        inv["status"] || "",
        i.status,
        i.resolved ? "Yes" : "No",
        formatEST(i.ts),
        inv["order id"] || "",
        inv["category"] || "",
        inv["subcategory"] || "",
        inv["customer"] || "",
      ]);
    });
  }

  const csvContent = rowsToCsv(rows);
  res.header("Content-Type", "text/csv");
  res.attachment(`shappi_full_audit_${Date.now()}.csv`);
  res.send(csvContent);
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
loadAuditStore();
io.on("connection", () => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

