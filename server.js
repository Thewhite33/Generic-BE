import express from "express";
import multer from "multer";
import cors from 'cors'
import XLSX from "xlsx";
import prisma from "./src/lib/prisma.js";

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*",              // React Native runs on device/emulator → no origin
    methods: ["GET", "POST"], // add PUT, DELETE if needed
    allowedHeaders: ["Content-Type", "Authorization"]
}));

const upload = multer({ dest: "uploads/" });

// ----------------------------------------------
// Helper: extract salt from CONTENTS
// ----------------------------------------------
function extractSalt(contents) {
    if (!contents) return null;
    if (["#N/A", "N/A", "NA"].includes(contents)) return null;

    const parts = contents.split(" ");

    let saltParts = [];
    for (let p of parts) {
        if (/\d/.test(p)) break;
        saltParts.push(p);
    }
    const salt = saltParts.join(" ").trim().toUpperCase();
    return salt || null;
}

// ----------------------------------------------
// Helper: read XLSX file into JSON rows
// ----------------------------------------------

function readExcelSmart(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // read entire sheet into array-of-arrays
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // find header row by scanning all rows
    let headerRowIndex = rows.findIndex(row =>
        row.some(col => String(col).trim().toUpperCase() === "PRODUCT NAME")
    );

    if (headerRowIndex === -1) {
        throw new Error("PRODUCT NAME header not found");
    }

    const header = rows[headerRowIndex].map(h => h.toString().trim());

    // read ALL rows below header, not stopping at empties
    const dataRows = rows.slice(headerRowIndex + 1);

    // convert to objects but keep all rows
    const parsed = dataRows.map(row => {
        let obj = {};
        header.forEach((h, idx) => {
            if (!h) return;
            obj[h] = row[idx] ?? "";
        });
        return obj;
    });

    // skip rows where entire row is empty
    return parsed.filter(r => {
        const val = r["PRODUCT NAME"]?.trim();
        return val && val !== "" && val !== null;
    });
}




// ----------------------------------------------
// 1) UPLOAD GENERIC XLSX
// ----------------------------------------------
app.post("/upload/generic", upload.single("file"), async (req, res) => {
    try {
        const rows = readExcelSmart(req.file.path);

        for (const row of rows) {
            const name = row["PRODUCT NAME"]?.trim();
            if (!name) continue;

            const contents = row["CONTENTS"] || null;
            const salt = extractSalt(contents);

            await prisma.genericMedicine.upsert({
                where: { genericName: name },
                update: {},
                create: {
                    genericName: name,
                    salt,
                    contents,
                    packing: row["PACKING"] || null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                }
            });
        }

        res.json({ success: true, message: "Generic uploaded successfully" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/upload/branded", upload.single("file"), async (req, res) => {
    try {
        const rows = readExcelSmart(req.file.path);

        for (const row of rows) {
            const name = row["PRODUCT NAME"]?.trim();
            if (!name) continue;

            const contents = row["CONTENTS"] || null;
            const salt = extractSalt(contents);

            await prisma.brandedMedicine.upsert({
                where: { brandedName: name },
                update: {},
                create: {
                    brandedName: name,
                    salt,
                    contents,
                    packing: row["PACKING"] !== undefined && row["PACKING"] !== null
                        ? String(row["PACKING"]).trim()
                        : null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                }
            });
        }

        res.json({ success: true, message: "Branded uploaded successfully" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/search/branded", async (req, res) => {
    const query = req.query.name;
    if (!query) return res.status(400).json({ error: "name is required" });

    const branded = await prisma.brandedMedicine.findFirst({
        where: {
            brandedName: {
                contains: query,
                mode: "insensitive"
            }
        }
    });

    if (!branded)
        return res.json({ error: "Branded medicine not found" });

    const generic = await prisma.genericMedicine.findFirst({
        where: { salt: branded.salt }
    });

    res.json({
        branded: branded.brandedName,
        generic: generic?.genericName || null,
        salt: branded.salt
    });
});

app.listen(5000, () => {
    console.log("Server running on http://localhost:5000");
});
