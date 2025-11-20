// server.js — Shappi Inventory App (with XLSX export)
// ---------------------------------------------------
import express from "express";
import multer from "multer";
import fs from "fs";
import csv from "csv-parser";
import cors from "cors";
import moment from "moment-timezone";
import XLSX from "xlsx";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* --------------------------------------------------
   STORAGE FOLDERS
-------------------------------------------------- */
if (!fs.existsSync("data")) fs.mkdirSync("data");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

/* --------------------------------------------------
   MULTER UPLOAD (CSV)
-------------------------------------------------- */
const upload = multer({ dest: "uploads/" });

let masterCSV = [];       // All CSV items
let masterBins = new Set(); // Valid bin IDs

/* --------------------------------------------------
   LOAD CSV INTO MEMORY
-------------------------------------------------- */
function loadCSVIntoMemory(filepath) {
  return new Promise((resolve) => {
    const rows = [];
    fs.createReadStream(filepath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows));
  });
}

/* --------------------------------------------------
   CSV UPLOAD ROUTE
-------------------------------------------------- */
app.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    const csvPath = req.file.path;

    masterCSV = await loadCSVIntoMemory(csvPath);

    masterBins = new Set(
      masterCSV.map((r) =>
        (r["Warehouse Bin ID"] || r["Warehouse Bin ID "] || "").trim()
      )
    );

    const meta = {
      total: masterCSV.length,
      uploadedAt: moment().tz("America/New_York").format("YYYY-MM-DD HH:mm:ss"),
    };

    fs.writeFileSync("data/csv-meta.json", JSON.stringify(meta));

    io.emit("csvUpdated", meta);

    res.json(meta);
  } catch (err) {
    console.error("CSV upload failed", err);
    res.status(500).json({ error: "CSV load failed" });
  }
});

/* --------------------------------------------------
   LIVE CSV STATUS
-------------------------------------------------- */
app.get("/csv-status", (req, res) => {
  try {
    const meta = JSON.parse(fs.readFileSync("data/csv-meta.json", "utf8"));
    res.json(meta);
  } catch (err) {
    res.json({ total: 0, uploadedAt: null });
  }
});

/* --------------------------------------------------
   BIN START
-------------------------------------------------- */
app.post("/audit/start/:binId", (req, res) => {
  const { binId } = req.params;
  const { auditor } = req.query;
  console.log(`Starting audit for BIN ${binId} by ${auditor}`);
  res.json({ ok: true });
});

/* --------------------------------------------------
   ITEM SCAN
-------------------------------------------------- */
app.post("/audit/scan", async (req, res) => {
  const { itemId, binId, auditor } = req.body;

  const record = masterCSV.find((r) => String(r["Item ID"]).trim() === itemId);

  if (!record) {
    return res.json({
      status: "no-bin",
      record: {},
    });
  }

  const expectedBin =
    (record["Warehouse Bin ID"] || record["Warehouse Bin ID "] || "").trim();

  let resolvedStatus = "";
  if (expectedBin === binId) resolvedStatus = "match";
  else resolvedStatus = expectedBin === "" ? "remove-item" : "mismatch";

  const responseRecord = {
    itemId,
    expectedBin,
    scannedBin: binId,
    received: record["Received at Warehouse"] || record["Received"] || "-",
    statusText: record["status"] || record["Status"] || "-",
  };

  res.json({
    status: resolvedStatus,
    correctBin: expectedBin,
    record: responseRecord,
  });
});

/* --------------------------------------------------
   RESOLUTION CHECKBOX
-------------------------------------------------- */
app.post("/audit/resolve", (req, res) => {
  console.log("Resolution updated:", req.body);
  res.json({ ok: true });
});

/* --------------------------------------------------
   EXPORT TABLE (CSV)
-------------------------------------------------- */
app.get("/export-summary", (req, res) => {
  const file = "data/summary.csv";
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.download(file);
});

/* --------------------------------------------------
   EXPORT FULL AUDIT — XLSX (2 SHEETS)
-------------------------------------------------- */
app.get("/export-full-audit", async (req, res) => {
  try {
    const auditFile = "data/full-audit.json";
    if (!fs.existsSync(auditFile))
      return res.status(400).send("No audit data available");

    const auditData = JSON.parse(fs.readFileSync(auditFile));

    const items = auditData.items || [];
    const summary = auditData.summary || [];

    /* ------------------------
       FORMAT DATES EST
    ------------------------ */
    const itemsFormatted = items.map((r) => ({
      ...r,
      scanTimestamp: moment(r.scanTimestamp)
        .tz("America/New_York")
        .format("YYYY-MM-DD HH:mm:ss"),
    }));

    /* ------------------------
       WORKBOOK
    ------------------------ */
    const workbook = XLSX.utils.book_new();

    // Sheet 1 — Full item-level audit
    const sheet1 = XLSX.utils.json_to_sheet(itemsFormatted);
    XLSX.utils.book_append_sheet(workbook, sheet1, "Audit Details");

    // Sheet 2 — Bin Summary
    const sheet2 = XLSX.utils.json_to_sheet(summary);
    XLSX.utils.book_append_sheet(workbook, sheet2, "Bin Summary");

    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=shappi_full_audit_${Date.now()}.xlsx`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(buffer);
  } catch (err) {
    console.error("Full audit export failed", err);
    res.status(500).send("Export failed");
  }
});

/* --------------------------------------------------
   SOCKET
-------------------------------------------------- */
io.on("connection", () => {
  console.log("Client connected");
});

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`Shappi Inventory Backend running on ${PORT}`)
);

