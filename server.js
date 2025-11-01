import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import csv from "csv-parser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads/" });

let inventoryData = [];

app.post("/upload-csv", upload.single("file"), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {
      inventoryData = results;
      fs.unlinkSync(req.file.path);
      res.json({ message: "CSV uploaded successfully", total: results.length });
    });
});

app.get("/check-item/:itemId/:binId", (req, res) => {
  const { itemId, binId } = req.params;
  const record = inventoryData.find((i) => i["Item ID"] === itemId);
  if (!record) return res.json({ status: "missing" });
  if (record["Warehouse Bin ID"] === binId)
    return res.json({ status: "match" });
  return res.json({
    status: "mismatch",
    correctBin: record["Warehouse Bin ID"],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

