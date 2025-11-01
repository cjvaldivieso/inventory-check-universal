import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import csv from "csv-parser";

const app = express();
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
let inventoryData = [];

// ✅ CSV Upload Endpoint
app.post("/upload-csv", upload.single("file"), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {
      inventoryData = results;
      fs.unlinkSync(req.file.path);
      res.json({ message: "CSV uploaded successfully", total: results.length });
    })
    .on("error", (err) => {
      res.status(500).json({ message: "Error reading CSV", error: err.message });
    });
});

// ✅ Endpoint for item check
app.get("/check-item/:itemId/:binId", (req, res) => {
  const { itemId, binId } = req.params;
  const record = inventoryData.find((i) => i["Item ID"] === itemId);

  if (!record) return res.json({ status: "missing" });
  if (record["Warehouse Bin ID"] === binId)
    return res.json({ status: "match" });
  return res.json({ status: "mismatch", correctBin: record["Warehouse Bin ID"] });
});

// ✅ Root route (health check)
app.get("/", (req, res) => {
  res.send("✅ Shappi Inventory PWA backend running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

