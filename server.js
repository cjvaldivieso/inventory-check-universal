import express from "express";
import multer from "multer";
import csvParser from "csv-parser";
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
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

let inventoryData = [];
let inventoryMap = {};
let audits = {};
let lastCsvTimestamp = null;

// ---------------- CSV UPLOAD ----------------
app.post("/upload-csv", upload.single("csv"), (req, res) => {
  console.log("📦 Upload hit:", req.file?.originalname);

  if (!req.file) {
    return res.status(400).json({ error: "No file received" });
  }

  const rows = [];
  const uploadTime = moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A");

  fs.createReadStream(req.file.path)
    .pipe(csvParser())
    .on("data", (row) => {
      const clean = {};
      for (const key in row) clean[key.trim().toLowerCase()] = row[key].trim();
      rows.push(clean);
    })
    .on("end", () => {
      fs.unlinkSync(req.file.path);

      inventoryData = rows;
      inventoryMap = {};
      rows.forEach(r => {
        const id = (r["item id"] || "").toUpperCase().trim();
        if (id) inventoryMap[id] = r;
      });

      lastCsvTimestamp = uploadTime;

      io.emit("csvUpdated", {
        total: rows.length,
        uploadedAt: uploadTime
      });

      res.json({
        total: rows.length,
        uploadedAt: uploadTime
      });
    });
});

// ---------------- CSV STATUS ----------------
app.get("/csv-status", (req, res) => {
  res.json({
    total: inventoryData.length,
    uploadedAt: lastCsvTimestamp || "(none)"
  });
});

// ---------------- BIN START ----------------
app.post("/audit/start/:binId", (req, res) => {
  const bin = req.params.binId.toUpperCase().trim();
  const auditor = req.query.auditor || "Unknown";

  const validBin = inventoryData.some(r =>
    r["warehouse bin id"]?.toUpperCase().trim() === bin
  );

  if (!validBin) {
    return res.status(400).json({ error: "Invalid bin - not in CSV" });
  }

  audits[bin] = {
    auditor,
    startTime: moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A"),
    items: {}
  };

  res.json({ bin, auditor });
});

// ---------------- ITEM SCAN ----------------
app.post("/audit/scan", (req, res) => {
  const { binId, itemId } = req.body;
  const auditor = req.query.auditor || "Unknown";
  const id = itemId.toUpperCase().trim();

  if (!audits[binId]) {
    return res.status(400).json({ error: "Bin not active" });
  }

  const rec = inventoryMap[id];
  let status = "no-bin";

  if (rec) {
    const correctBin = rec["warehouse bin id"];
    status = (correctBin === binId) ? "match" : "mismatch";
  }

  audits[binId].items[id] = {
    itemId: id,
    scanTime: moment().tz("America/New_York").format("MM/DD/YYYY hh:mm A"),
    status,
    meta: rec || {}
  };

  res.json({
    status,
    record: rec || null,
    correctBin: rec?.["warehouse bin id"] || null
  });
});

// ---------------- FULL AUDIT EXPORT ----------------
app.get("/export-full-audit", (req, res) => {
  const rows = [
    ["Bin","Item ID","Status","Customer","Category","Subcategory","Scan Time"]
  ];

  for (const bin in audits) {
    const audit = audits[bin];

    for (const id in audit.items) {
      const item = audit.items[id];
      const meta = item.meta;
      rows.push([
        bin,
        id,
        item.status,
        meta?.customer || "",
        meta?.category || "",
        meta?.subcategory || "",
        item.scanTime
      ]);
    }
  }

  const csv = rows.map(r =>
    r.map(v => `"${(v||"").replace(/"/g, '""')}"`).join(",")
  ).join("\n");

  res.header("Content-Type", "text/csv");
  res.attachment("full_audit_est.csv");
  res.send(csv);
});

server.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Running on port", process.env.PORT || 3000)
);

