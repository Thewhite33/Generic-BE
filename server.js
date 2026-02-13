import express from "express";
import multer from "multer";
import cors from 'cors';
import XLSX from "xlsx";
import prisma from "./src/lib/prisma.js";

const app = express();
app.use(express.json());

app.use(cors({
    origin: "*",              
    methods: ["GET", "POST"], 
    allowedHeaders: ["Content-Type", "Authorization"]
}));

const upload = multer({ dest: "uploads/" });

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract salt/active ingredient from contents string
 */
function extractSalt(contents) {
    if (!contents) return null;
    
    // Convert to string and trim
    const contentsStr = String(contents).trim();
    
    // Check for N/A values
    if (["#N/A", "N/A", "NA", ""].includes(contentsStr)) return null;
    
    const parts = contentsStr.split(" ");
    let saltParts = [];
    
    for (let p of parts) {
        if (/\d/.test(p)) break;
        saltParts.push(p);
    }
    
    const salt = saltParts.join(" ").trim().toUpperCase();
    return salt || null;
}

/**
 * Clean contents field - convert N/A values to null
 */
function cleanContents(contents) {
    if (!contents) return null;
    const contentsStr = String(contents).trim();
    if (["#N/A", "N/A", "NA", ""].includes(contentsStr)) return null;
    return contentsStr;
}

/**
 * Detect medicine type from product name
 */
function detectType(productName) {
    if (!productName) return null;
    
    const name = productName.toUpperCase();
    
    // Tablet types
    if (name.includes("TAB") || name.includes("TABLET")) return "TABLET";
    
    // Capsule types
    if (name.includes("CAP") || name.includes("CAPSULE")) return "CAPSULE";
    
    // Injectable types
    if (name.includes("INJ") || name.includes("INJECTION")) return "INJECTION";
    
    // Syrup types
    if (name.includes("SYR") || name.includes("SYRUP") || name.includes("SUSP") || name.includes("SUSPENSION")) return "SYRUP";
    
    // Cream/Ointment types
    if (name.includes("CREAM") || name.includes("OINTMENT") || name.includes("GEL")) return "TOPICAL";
    
    // Drops
    if (name.includes("DROP") || name.includes("DROPS")) return "DROPS";
    
    // Powder
    if (name.includes("POWDER") || name.includes("SACHET")) return "POWDER";
    
    // Inhaler
    if (name.includes("INHALER") || name.includes("ROTACAP") || name.includes("RESPULE")) return "INHALER";
    
    return "OTHER";
}

/**
 * Calculate Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    return matrix[len1][len2];
}

/**
 * Calculate similarity score (0-1, where 1 is exact match)
 */
function similarityScore(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    
    const distance = levenshteinDistance(s1, s2);
    return 1 - (distance / maxLen);
}

/**
 * Normalize string for better matching (remove common variations)
 */
function normalizeString(str) {
    if (!str) return "";
    
    return str
        .toUpperCase()
        .replace(/\s+/g, " ")           // normalize whitespace
        .replace(/[()]/g, "")           // remove parentheses
        .replace(/\bTABLET\b|\bTAB\b/g, "TAB")
        .replace(/\bCAPSULE\b|\bCAP\b/g, "CAP")
        .replace(/\bINJECTION\b|\bINJ\b/g, "INJ")
        .replace(/\bSYRUP\b|\bSYR\b/g, "SYR")
        .trim();
}

/**
 * Smart Excel reader that finds headers dynamically
 */
function readExcelSmart(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    let headerRowIndex = rows.findIndex(row =>
        row.some(col => String(col).trim().toUpperCase() === "PRODUCT NAME")
    );

    if (headerRowIndex === -1) {
        throw new Error("PRODUCT NAME header not found");
    }

    const header = rows[headerRowIndex].map(h => h.toString().trim());
    const dataRows = rows.slice(headerRowIndex + 1);

    const parsed = dataRows.map(row => {
        let obj = {};
        header.forEach((h, idx) => {
            if (!h) return;
            obj[h] = row[idx] ?? "";
        });
        return obj;
    });

    return parsed.filter(r => {
        const val = r["PRODUCT NAME"]?.trim();
        return val && val !== "" && val !== null;
    });
}

// ============================================================================
// UPLOAD ENDPOINTS
// ============================================================================

app.post("/upload/generic", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                error: "No file uploaded",
                message: "Please upload a file with field name 'file'"
            });
        }
        
        const rows = readExcelSmart(req.file.path);
        let created = 0;
        let updated = 0;

        for (const row of rows) {
            const name = row["PRODUCT NAME"]?.trim();
            if (!name) continue;

            const rawContents = row["CONTENTS"];
            const contents = cleanContents(rawContents);
            const salt = extractSalt(rawContents);
            const type = detectType(name);

            const existing = await prisma.genericMedicine.findUnique({
                where: { genericName: name }
            });

            await prisma.genericMedicine.upsert({
                where: { genericName: name },
                update: {
                    salt,
                    contents,
                    type,
                    packing: row["PACKING"] !== undefined && row["PACKING"] !== null 
                        ? String(row["PACKING"]).trim() 
                        : null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                },
                create: {
                    genericName: name,
                    salt,
                    contents,
                    type,
                    packing: row["PACKING"] !== undefined && row["PACKING"] !== null 
                        ? String(row["PACKING"]).trim() 
                        : null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                }
            });

            existing ? updated++ : created++;
        }

        res.json({ 
            success: true, 
            message: "Generic medicines uploaded successfully",
            stats: { created, updated, total: created + updated }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/upload/branded", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                error: "No file uploaded",
                message: "Please upload a file with field name 'file'"
            });
        }
        
        const rows = readExcelSmart(req.file.path);
        let created = 0;
        let updated = 0;

        for (const row of rows) {
            const name = row["PRODUCT NAME"]?.trim();
            if (!name) continue;

            const rawContents = row["CONTENTS"];
            const contents = cleanContents(rawContents);
            const salt = extractSalt(rawContents);
            const type = detectType(name);

            const existing = await prisma.brandedMedicine.findUnique({
                where: { brandedName: name }
            });

            await prisma.brandedMedicine.upsert({
                where: { brandedName: name },
                update: {
                    salt,
                    contents,
                    type,
                    packing: row["PACKING"] !== undefined && row["PACKING"] !== null
                        ? String(row["PACKING"]).trim()
                        : null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                },
                create: {
                    brandedName: name,
                    salt,
                    contents,
                    type,
                    packing: row["PACKING"] !== undefined && row["PACKING"] !== null
                        ? String(row["PACKING"]).trim()
                        : null,
                    ptr: row["PTR"] ? parseFloat(row["PTR"]) : null,
                    mrp: row["MRP"] ? parseFloat(row["MRP"]) : null,
                    shipperSize: row["SHIPPER SIZE"] ? parseInt(row["SHIPPER SIZE"]) : null
                }
            });

            existing ? updated++ : created++;
        }

        res.json({ 
            success: true, 
            message: "Branded medicines uploaded successfully",
            stats: { created, updated, total: created + updated }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// SEARCH ENDPOINTS WITH FUZZY MATCHING
// ============================================================================

app.get("/search/branded", async (req, res) => {
    try {
        const query = req.query.name;
        if (!query) {
            return res.status(400).json({ error: "name parameter is required" });
        }

        // Step 1: Try exact match (case-insensitive)
        let branded = await prisma.brandedMedicine.findFirst({
            where: {
                brandedName: {
                    equals: query,
                    mode: "insensitive"
                }
            }
        });

        // Step 2: Try contains match
        if (!branded) {
            branded = await prisma.brandedMedicine.findFirst({
                where: {
                    brandedName: {
                        contains: query,
                        mode: "insensitive"
                    }
                }
            });
        }

        // Step 3: Fuzzy matching if still not found
        if (!branded) {
            const allBranded = await prisma.brandedMedicine.findMany({
                select: {
                    id: true,
                    brandedName: true,
                    salt: true,
                    contents: true,
                    type: true,
                    packing: true,
                    ptr: true,
                    mrp: true,
                    shipperSize: true
                }
            });

            const normalizedQuery = normalizeString(query);
            let bestMatch = null;
            let bestScore = 0;

            for (const medicine of allBranded) {
                const normalizedName = normalizeString(medicine.brandedName);
                const score = similarityScore(normalizedQuery, normalizedName);
                
                if (score > bestScore && score > 0.6) { // 60% similarity threshold
                    bestScore = score;
                    bestMatch = medicine;
                }
            }

            if (bestMatch) {
                branded = bestMatch;
            }
        }

        if (!branded) {
            return res.status(404).json({ 
                error: "Branded medicine not found",
                suggestion: "Please check the spelling or try a different search term"
            });
        }

        // Find all generic alternatives with the same salt
        const generics = await prisma.genericMedicine.findMany({
            where: { 
                salt: branded.salt,
                salt: { not: null }
            },
            orderBy: {
                ptr: 'asc' // Order by price, cheapest first
            }
        });

        res.json({
            branded: {
                name: branded.brandedName,
                salt: branded.salt,
                contents: branded.contents,
                type: branded.type,
                packing: branded.packing,
                ptr: branded.ptr,
                mrp: branded.mrp,
                shipperSize: branded.shipperSize
            },
            generics: generics.map(g => ({
                name: g.genericName,
                salt: g.salt,
                contents: g.contents,
                type: g.type,
                packing: g.packing,
                ptr: g.ptr,
                mrp: g.mrp,
                shipperSize: g.shipperSize,
                savings: branded.ptr && g.ptr ? 
                    ((branded.ptr - g.ptr) / branded.ptr * 100).toFixed(2) + '%' : null
            })),
            totalGenerics: generics.length
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/search/generic", async (req, res) => {
    try {
        const query = req.query.name;
        if (!query) {
            return res.status(400).json({ error: "name parameter is required" });
        }

        // Try exact match first
        let generic = await prisma.genericMedicine.findFirst({
            where: {
                genericName: {
                    equals: query,
                    mode: "insensitive"
                }
            }
        });

        // Try contains match
        if (!generic) {
            generic = await prisma.genericMedicine.findFirst({
                where: {
                    genericName: {
                        contains: query,
                        mode: "insensitive"
                    }
                }
            });
        }

        // Fuzzy matching
        if (!generic) {
            const allGenerics = await prisma.genericMedicine.findMany({
                select: {
                    id: true,
                    genericName: true,
                    salt: true,
                    contents: true,
                    type: true,
                    packing: true,
                    ptr: true,
                    mrp: true,
                    shipperSize: true
                }
            });

            const normalizedQuery = normalizeString(query);
            let bestMatch = null;
            let bestScore = 0;

            for (const medicine of allGenerics) {
                const normalizedName = normalizeString(medicine.genericName);
                const score = similarityScore(normalizedQuery, normalizedName);
                
                if (score > bestScore && score > 0.6) {
                    bestScore = score;
                    bestMatch = medicine;
                }
            }

            if (bestMatch) {
                generic = bestMatch;
            }
        }

        if (!generic) {
            return res.status(404).json({ 
                error: "Generic medicine not found",
                suggestion: "Please check the spelling or try a different search term"
            });
        }

        // Find branded alternatives with the same salt
        const branded = await prisma.brandedMedicine.findMany({
            where: { 
                salt: generic.salt,
                salt: { not: null }
            },
            orderBy: {
                ptr: 'asc'
            }
        });

        res.json({
            generic: {
                name: generic.genericName,
                salt: generic.salt,
                contents: generic.contents,
                type: generic.type,
                packing: generic.packing,
                ptr: generic.ptr,
                mrp: generic.mrp,
                shipperSize: generic.shipperSize
            },
            brandedAlternatives: branded.map(b => ({
                name: b.brandedName,
                salt: b.salt,
                contents: b.contents,
                type: b.type,
                packing: b.packing,
                ptr: b.ptr,
                mrp: b.mrp,
                shipperSize: b.shipperSize
            })),
            totalBranded: branded.length
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Search by salt/active ingredient
app.get("/search/salt", async (req, res) => {
    try {
        const query = req.query.name;
        if (!query) {
            return res.status(400).json({ error: "name parameter is required" });
        }

        const normalizedQuery = query.toUpperCase().trim();

        const [generics, branded] = await Promise.all([
            prisma.genericMedicine.findMany({
                where: {
                    salt: {
                        contains: normalizedQuery,
                        mode: "insensitive"
                    }
                },
                orderBy: { ptr: 'asc' }
            }),
            prisma.brandedMedicine.findMany({
                where: {
                    salt: {
                        contains: normalizedQuery,
                        mode: "insensitive"
                    }
                },
                orderBy: { ptr: 'asc' }
            })
        ]);

        if (generics.length === 0 && branded.length === 0) {
            return res.status(404).json({ 
                error: "No medicines found with this active ingredient"
            });
        }

        res.json({
            salt: normalizedQuery,
            generics: generics.map(g => ({
                name: g.genericName,
                contents: g.contents,
                type: g.type,
                packing: g.packing,
                ptr: g.ptr,
                mrp: g.mrp
            })),
            branded: branded.map(b => ({
                name: b.brandedName,
                contents: b.contents,
                type: b.type,
                packing: b.packing,
                ptr: b.ptr,
                mrp: b.mrp
            })),
            totalResults: generics.length + branded.length
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Endpoints available:`);
    console.log(`   POST /upload/generic - Upload generic medicines`);
    console.log(`   POST /upload/branded - Upload branded medicines`);
    console.log(`   GET  /search/branded?name=<name> - Search branded medicine`);
    console.log(`   GET  /search/generic?name=<name> - Search generic medicine`);
    console.log(`   GET  /search/salt?name=<salt> - Search by active ingredient`);
    console.log(`   GET  /health - Health check`);
});