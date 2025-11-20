import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import moment from "moment-timezone";
import xlsx from "xlsx";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads/" });

// --------------------
// ACTIVE INVENTORY DATA
// --------------------
let inventory = [];
let lastUploadMeta = null;

// --------------------
// HELPERS
// --------------------
const EST = "America/New_York";

function toEST(iso) {
  if (!iso) return "";
  return moment(iso).tz(EST).format("MM/DD/YYYY h:mm A");
}

function normalizeBin(bin) {
  return String(bin || "").trim().toUpperCase();
}

// --------------------
// UPLOAD CSV OR XLSX
// --------------------
app.post("/upload-csv", upload.single("csv"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  inventory = [];

  try {
    if (ext === ".xlsx") {
      const workbook = xlsx.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet);

      inventory = rows.map(row => ({
        orderId: row["Order ID"] || "",
        itemId: row["Item ID"] || "",
        expectedBin: normalizeBin(row["Expected Bin"]),
        scannedBin: "",
        category: row["Category"] || "",
        subcategory: row["Subcategory"] || "",
        customer: row["Customer"] || "",
        whReceived: row["WH Received"] || "",
        status: row["Shappi Status"] || "",
        auditStatus: "",
        resolved: "No",
        scanTimestamp: null
      }));

    } else {
      await new Promise((resolve) => {
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on("data", row => {
            inventory.push({
              orderId: row["Order ID"] || "",
              itemId: row["Item ID"] || "",
              expectedBin: normalizeBin(row["Expected Bin"]),
              scannedBin: "",
              category: row["Category"] || "",
              subcategory: row["Subcategory"] || "",
              customer: row["Customer"] || "",
              whReceived: row["WH Received"] || "",
              status: row["Shappi Status"] || "",
              auditStatus: "",
              resolved: "No",
              scanTimestamp: null
            });
          })
          .on("end", resolve);
      });
    }

    lastUploadMeta = {
      count: inventory.length,
      timestamp: new Date().toISOString()
    };

    fs.unlinkSync(filePath);
    res.json(lastUploadMeta);

  } catch (err) {
    console.error("Upload parse error:", err);
    res.status(500).json({ error: "Failed to parse file" });
  }
});

// --------------------
// VALIDATE BIN
// --------------------
app.get("/validate-bin/:bin", (req, res) => {
  const bin = normalizeBin(req.params.bin);

  const exists = inventory.some(i => normalizeBin(i.expectedBin) === bin);

  res.json({
    valid: exists,
    bin
  });
});

// --------------------
// ITEM SCAN UPDATE
// --------------------
app.post("/scan-item", (req, res) => {
  const { bin, itemId, auditor } = req.body;
  const normBin = normalizeBin(bin);

  const item = inventory.find(i =>
    String(i.itemId).trim() === String(itemId).trim()
  );

  if (!item) {
    return res.json({ status: "not-found", itemId });
  }

  item.scannedBin = normBin;
  item.scanTimestamp = new Date().toISOString();

  if (item.expectedBin === normBin) {
    item.auditStatus = "match";
  } else {
    item.auditStatus = "mismatch";
  }

  item.resolved = "No";

  res.json({ status: "ok", item });
});

// --------------------
// FULL AUDIT EXPORT (XLSX w/ Tabs)
// --------------------
app.get("/export-full-audit", async (req, res) => {
  try {
    const workbook = xlsx.utils.book_new();

    // ---------- TAB 1: ITEM LEVEL ----------
    const rows = inventory.map(i => ({
      "Order ID": i.orderId,
      "Item ID": i.itemId,
      "Category": i.category,
      "Subcategory": i.subcategory,
      "Customer": i.customer,
      "Expected Bin": i.expectedBin,
      "Scanned Bin": i.scannedBin,
      "Audit Status": i.auditStatus,
      "WH Received": i.whReceived,
      "Shappi Status": i.status,
      "Resolved": i.resolved,
      "Scan Timestamp (EST)": toEST(i.scanTimestamp)
    }));

    const sheet1 = xlsx.utils.json_to_sheet(rows);
    xlsx.utils.book_append_sheet(workbook, sheet1, "Item Audit");

    // ---------- TAB 2: BIN SUMMARY ----------
    const summaryMap = {};

    inventory.forEach(item => {
      const bin = item.expectedBin;

      if (!summaryMap[bin]) {
        summaryMap[bin] = {
          bin,
          expected: 0,
          matched: 0,
          missing: []
        };
      }

      summaryMap[bin].expected++;

      if (item.expectedBin === item.scannedBin) {
        summaryMap[bin].matched++;
      } else {
        summaryMap[bin].missing.push(item.itemId);
      }
    });

    const summaryRows = Object.values(summaryMap).map(b => ({
      "Bin": b.bin,
      "Expected Items": b.expected,
      "Matched Items": b.matched,
      "Missing Count": b.expected - b.matched,
      "Missing Item IDs": b.missing.join(", ")
    }));

    const sheet2 = xlsx.utils.json_to_sheet(summaryRows);
    xlsx.utils.book_append_sheet(workbook, sheet2, "Bin Summary");

    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=full_audit.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);

  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

