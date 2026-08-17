require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// =====================================
// POSTGRESQL
// =====================================

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", (error) => {
  console.error(
    "Unexpected PostgreSQL error:",
    error
  );
});

async function testDatabaseConnection() {
  try {
    await pool.query(
      "SELECT NOW()"
    );

    console.log(
      "PostgreSQL database connected successfully."
    );

  } catch (error) {
    console.error(
      "PostgreSQL connection error:",
      error.message
    );
  }
}

testDatabaseConnection();

// =====================================
// CASE LANGUAGE
// =====================================

const supportedCaseLanguages = [
  "urdu",
  "english",
  "japanese",
  "sinhala"
];

function normalizeCaseLanguage(
  language
) {

  const value =
    String(
      language ||
      "urdu"
    )
      .trim()
      .toLowerCase();

  return supportedCaseLanguages
    .includes(value)
      ? value
      : "urdu";
}

async function ensureLanguageColumn() {

  try {

    await pool.query(
      `
      ALTER TABLE vehicle_cases
      ADD COLUMN IF NOT EXISTS language VARCHAR(20)
      `
    );

    await pool.query(
      `
      UPDATE vehicle_cases
      SET language = 'urdu'
      WHERE language IS NULL
         OR TRIM(language) = ''
      `
    );

    console.log(
      "Vehicle case language column ready."
    );

  } catch (error) {

    console.error(
      "CASE LANGUAGE COLUMN ERROR:",
      error.message
    );
  }
}

ensureLanguageColumn();

// =====================================
// UPLOAD
// =====================================

const upload = multer({
  dest: "uploads/",

  limits: {
    fileSize:
      15 * 1024 * 1024
  },

  fileFilter: (
    req,
    file,
    cb
  ) => {

    const isImage =
      file.mimetype.startsWith(
        "image/"
      );

    const isPdf =
      file.mimetype ===
      "application/pdf";

    if (
      isImage ||
      isPdf
    ) {

      cb(null, true);

    } else {

      cb(
        new Error(
          "Only image files or PDF files are allowed."
        )
      );
    }
  }
});

// =====================================
// CASE ID
// =====================================

function createCaseId() {

  const time =
    Date.now();

  const random =
    Math.floor(
      1000 +
      Math.random() *
      9000
    );

  return `CASE-${time}-${random}`;
}

// =====================================
// CREATE CASE
// =====================================

async function createVehicleCase(
  language = "urdu"
) {

  const caseId =
    createCaseId();

  const caseLanguage =
    normalizeCaseLanguage(
      language
    );

  await pool.query(
    `
    INSERT INTO vehicle_cases (
      case_id,
      status,
      language
    )
    VALUES ($1, 'open', $2)
    `,
    [
      caseId,
      caseLanguage
    ]
  );

  return caseId;
}

// =====================================
// ENSURE CASE
// =====================================

async function ensureCase(
  caseId,
  language = "urdu"
) {

  const caseLanguage =
    normalizeCaseLanguage(
      language
    );

  if (!caseId) {

    return await
      createVehicleCase(
        caseLanguage
      );
  }

  const result =
    await pool.query(
      `
      SELECT case_id
      FROM vehicle_cases
      WHERE case_id = $1
      LIMIT 1
      `,
      [caseId]
    );

  if (
    result.rows.length > 0
  ) {

    await pool.query(
      `
      UPDATE vehicle_cases
      SET
        language = $2,
        updated_at =
          CURRENT_TIMESTAMP
      WHERE case_id = $1
      `,
      [
        caseId,
        caseLanguage
      ]
    );

    return caseId;
  }

  await pool.query(
    `
    INSERT INTO vehicle_cases (
      case_id,
      status,
      language
    )
    VALUES ($1, 'open', $2)
    `,
    [
      caseId,
      caseLanguage
    ]
  );

  return caseId;
}

// =====================================
// IDENTIFIER EXTRACTION
// =====================================

function cleanIdentifier(
  value
) {

  if (!value) {
    return null;
  }

  return value
    .trim()
    .replace(/[.,;]+$/, "")
    .toUpperCase();
}

function extractVehicleData(text) {

  if (!text) {
    return {};
  }

  const data = {};

  // =========================
  // VIN - 17 characters
  // =========================

  const vinMatch =
    text.match(
      /\bVIN\s*[:#-]?\s*([A-HJ-NPR-Z0-9]{17})\b/i
    ) ||
    text.match(
      /\b([A-HJ-NPR-Z0-9]{17})\b/i
    );

  if (vinMatch) {
    data.vin =
      cleanIdentifier(
        vinMatch[1]
      );
  }

  // =========================
  // FRAME / CHASSIS NUMBER
  // =========================

  const chassisMatch =
    text.match(
      /(?:FRAME\s*(?:NUMBER|NO\.?)?|CHASSIS\s*(?:NUMBER|NO\.?)?)\s*[:#-]\s*([A-Z0-9]+-[A-Z0-9-]+)/i
    );

  if (chassisMatch) {
    data.chassisNumber =
      cleanIdentifier(
        chassisMatch[1]
      );
  }

  // Japanese style frame number fallback
  if (!data.chassisNumber) {

    const japanFrame =
  text.match(
    /\b((?=[A-Z0-9]{2,10}-)(?=(?:[A-Z0-9]*[A-Z]){2})[A-Z0-9]{2,10}-[0-9]{4,10})\b/i
  );

    if (japanFrame) {
      data.chassisNumber =
        cleanIdentifier(
          japanFrame[1]
        );
    }
  }

  // =========================
  // MODEL CODE
  // =========================

  const modelCodeMatch =
  text.match(
    /(?:MODEL\s*CODE|MODEL\s*NO\.?|MODEL\s*NUMBER)\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{2,30})/i
  );

  if (modelCodeMatch) {
    data.modelCode =
      cleanIdentifier(
        modelCodeMatch[1]
      );
  }

  // =========================
  // ENGINE CODE
  // =========================
const engineMatch =
  text.match(
    /(?:ENGINE\s*CODE|ENGINE\s*NO\.?|ENGINE\s*NUMBER)\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{2,20})/i
  );

if (engineMatch) {
  data.engineCode =
    cleanIdentifier(
      engineMatch[1]
    );
}

  // =========================
  // MILEAGE
  // =========================

  const mileageMatch =
    text.match(
      /(?:MILEAGE|ODOMETER)\s*[:#-]\s*([0-9][0-9,.]*\s*(?:KM|KMS|MI|MILES)?)\b/i
    );

  if (mileageMatch) {
    data.mileage =
      mileageMatch[1].trim();
  }

  return data;
}

// =====================================
// UPDATE VEHICLE IDENTITY
// =====================================

async function updateVehicleIdentity(
  caseId,
  data
) {

  if (
    !data ||
    Object.keys(data).length === 0
  ) {
    return;
  }

  await pool.query(
    `
    UPDATE vehicle_cases

    SET
      vin =
        COALESCE($2, vin),

      chassis_number =
        COALESCE(
          $3,
          chassis_number
        ),

      model_code =
        COALESCE(
          $4,
          model_code
        ),

      engine_code =
        COALESCE(
          $5,
          engine_code
        ),

      mileage =
        COALESCE(
          $6,
          mileage
        ),

      updated_at =
        CURRENT_TIMESTAMP

    WHERE case_id = $1
    `,
    [
      caseId,
      data.vin || null,
      data.chassisNumber || null,
      data.modelCode || null,
      data.engineCode || null,
      data.mileage || null
    ]
  );
}

// =====================================
// SAVE DIAGNOSTIC RECORD
// =====================================

async function saveDiagnosticRecord({
  caseId,
  question,
  answer,
  fileName,
  responseId,
  recordType
}) {

  await pool.query(
    `
    INSERT INTO diagnostic_records (
      case_id,
      record_type,
      user_question,
      ai_answer,
      file_name,
      openai_response_id
    )

    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6
    )
    `,
    [
      caseId,
      recordType,
      question || null,
      answer || null,
      fileName || null,
      responseId || null
    ]
  );

  await pool.query(
    `
    UPDATE vehicle_cases

    SET updated_at =
      CURRENT_TIMESTAMP

    WHERE case_id = $1
    `,
    [caseId]
  );
}

// =====================================
// DTC EXTRACTION + AUTO SAVE
// =====================================

function normalizeDtcField(value) {
  if (!value) return null;

  const cleaned = String(value).trim();

  if (
    !cleaned ||
    /^(UNKNOWN|N\/?A|NOT AVAILABLE|NOT PROVIDED|NULL)$/i.test(cleaned)
  ) {
    return null;
  }

  return cleaned;
}

function extractDtcDetails(userText, aiText) {
  const records = new Map();
  const dtcRegex = /\b(?:P|B|C|U)[0-9A-F]{4}(?:-[0-9A-F]{2})?\b/gi;

  const userSource = String(userText || "");
  const aiSource = String(aiText || "");
  const combinedSource = `${userSource}\n${aiSource}`;

  // 1) Only DTCs that are actually present in the user's evidence
  // become database records. This prevents hypothetical AI codes
  // from being stored as real faults.
  const userMatches = userSource.match(dtcRegex) || [];

  for (const rawCode of userMatches) {
    const code = rawCode.toUpperCase();

    if (!records.has(code)) {
      records.set(code, {
        code,
        module: null,
        description: null,
        status: null,
        priority: null
      });
    }
  }

  if (records.size === 0) {
    return [];
  }

  // Helper: merge new information without deleting existing values.
  const mergeRecord = (code, details = {}) => {
    const normalizedCode = String(code || "").toUpperCase();

    if (!records.has(normalizedCode)) {
      return;
    }

    const existing = records.get(normalizedCode);

    records.set(normalizedCode, {
      code: normalizedCode,
      module:
        normalizeDtcField(details.module) ||
        existing.module ||
        null,
      description:
        normalizeDtcField(details.description) ||
        existing.description ||
        null,
      status:
        normalizeDtcField(details.status) ||
        existing.status ||
        null,
      priority:
        normalizeDtcField(details.priority) ||
        existing.priority ||
        null
    });
  };

  // 2) Parse AI machine-readable DTC_RECORD lines.
  // This is deliberately tolerant of bullets, markdown, code fences,
  // and extra spaces before DTC_RECORD.
  const recordRegex =
    /DTC_RECORD\s*:\s*CODE\s*=\s*((?:P|B|C|U)[0-9A-F]{4}(?:-[0-9A-F]{2})?)\s*\|\s*MODULE\s*=\s*([^|\r\n]+)\s*\|\s*DESCRIPTION\s*=\s*([^|\r\n]+)\s*\|\s*STATUS\s*=\s*([^|\r\n]+)\s*\|\s*PRIORITY\s*=\s*([^\r\n`]+)/gi;

  let recordMatch;

  while ((recordMatch = recordRegex.exec(aiSource)) !== null) {
    mergeRecord(recordMatch[1], {
      module: recordMatch[2],
      description: recordMatch[3],
      status: recordMatch[4],
      priority: recordMatch[5]
    });
  }

  // 3) Fallback parser.
  // If the model did not follow the machine-readable format exactly,
  // inspect a small text window around each real user DTC and pull
  // common labels such as Module:, Description:, Status:, Priority:.
  for (const code of records.keys()) {
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const codeRegex = new RegExp(escapedCode, "ig");
    let codeMatch;

    while ((codeMatch = codeRegex.exec(combinedSource)) !== null) {
      const start = Math.max(0, codeMatch.index - 250);
      const end = Math.min(
        combinedSource.length,
        codeMatch.index + code.length + 650
      );

      const windowText = combinedSource.slice(start, end);

      const getLabel = (label) => {
        const match = windowText.match(
          new RegExp(
            `${label}\\s*[:=-]\\s*([^\\r\\n|]+)`,
            "i"
          )
        );

        return normalizeDtcField(match ? match[1] : null);
      };

      mergeRecord(code, {
        module:
          getLabel("MODULE") ||
          getLabel("CONTROL MODULE"),
        description:
          getLabel("DESCRIPTION") ||
          getLabel("DTC DESCRIPTION"),
        status:
          getLabel("STATUS") ||
          getLabel("DTC STATUS"),
        priority:
          getLabel("PRIORITY")
      });
    }
  }

  // 4) User-message fallback for common compact workshop input such as:
  // ECM
  // DTC P0420
  // Status: Current
  // The module/status are only copied when the user's message contains
  // exactly one DTC, which avoids assigning one module to several codes
  // incorrectly.
  if (records.size === 1) {
    const onlyCode = [...records.keys()][0];

    const explicitStatus =
      userSource.match(
        /\b(?:DTC\s*)?STATUS\s*[:=-]\s*([^\r\n|]+)/i
      );

    const explicitModule =
      userSource.match(
        /\bMODULE\s*[:=-]\s*([A-Z0-9 _/-]{2,40})/i
      );

    const standaloneModule =
      userSource.match(
        /(?:^|\r?\n)\s*(ECM|PCM|TCM|BCM|ABS|SRS|EPS|HVAC|ADAS|VSA|ESP|EBCM|ECU)\s*(?:\r?\n|$)/i
      );

    mergeRecord(onlyCode, {
      module:
        explicitModule?.[1] ||
        standaloneModule?.[1] ||
        null,
      status:
        explicitStatus?.[1] ||
        null
    });
  }

  return [...records.values()];
}


async function saveDtcRecords(caseId, dtcRecords, sourceText) {
  if (!caseId || !Array.isArray(dtcRecords) || dtcRecords.length === 0) {
    return;
  }

  for (const record of dtcRecords) {
    const dtcCode = record.code.toUpperCase();

    const existing = await pool.query(
      `
      SELECT id
      FROM dtc_records
      WHERE case_id = $1
        AND UPPER(COALESCE(dtc_code, '')) = $2
      LIMIT 1
      `,
      [caseId, dtcCode]
    );

    if (existing.rows.length > 0) {
      // Enrich an existing DTC instead of creating a duplicate row.
      await pool.query(
        `
        UPDATE dtc_records
        SET
          module_name = COALESCE($2, module_name),
          description = COALESCE($3, description),
          status = COALESCE($4, status),
          priority = COALESCE($5, priority),
          source_text = COALESCE(source_text, $6)
        WHERE id = $1
        `,
        [
          existing.rows[0].id,
          record.module || null,
          record.description || null,
          record.status || null,
          record.priority || null,
          sourceText || null
        ]
      );

      continue;
    }

    await pool.query(
      `
      INSERT INTO dtc_records (
        case_id,
        dtc_code,
        module_name,
        description,
        status,
        priority,
        source_text
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        caseId,
        dtcCode,
        record.module || null,
        record.description || null,
        record.status || null,
        record.priority || null,
        sourceText || null
      ]
    );
  }
}

// =====================================
// HOME
// =====================================

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.get(
  "/index.html",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

// =====================================
// NEW CASE
// =====================================

app.post(
  "/new-case",
  async (
    req,
    res
  ) => {

    try {

      const language =
        normalizeCaseLanguage(
          req.body?.language
        );

      const caseId =
        await
          createVehicleCase(
            language
          );

      res.json({
        success: true,
        caseId,
        language
      });

    } catch (error) {

      console.error(
        "NEW CASE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not create diagnostic case."
      });
    }
  }
);

// =====================================
// CASE HISTORY
// =====================================

app.get(
  "/case/:caseId",
  async (
    req,
    res
  ) => {

    try {

      const caseId =
        req.params.caseId;

      const vehicleResult =
        await pool.query(
          `
          SELECT *
          FROM vehicle_cases
          WHERE case_id = $1
          `,
          [caseId]
        );

      if (
        vehicleResult
          .rows
          .length === 0
      ) {

        return res
          .status(404)
          .json({
            error:
              "Case not found."
          });
      }

      const historyResult =
        await pool.query(
          `
          SELECT *
          FROM diagnostic_records
          WHERE case_id = $1
          ORDER BY created_at ASC
          `,
          [caseId]
        );

      const dtcResult =
        await pool.query(
          `
          SELECT *
          FROM dtc_records
          WHERE case_id = $1
          ORDER BY created_at ASC
          `,
          [caseId]
        );

      res.json({
        vehicle:
          vehicleResult.rows[0],

        history:
          historyResult.rows,

        dtcs:
          dtcResult.rows
      });

    } catch (error) {

      console.error(
        "CASE HISTORY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not load case history."
      });
    }
  }
);

// =====================================
// VEHICLE SEARCH
// VIN / CHASSIS / MODEL CODE
// =====================================

app.get(
  "/vehicle-search/:query",
  async (
    req,
    res
  ) => {

    try {

      const query =
        req.params.query
          .trim()
          .toUpperCase();

      const result =
        await pool.query(
          `
          SELECT *
          FROM vehicle_cases

          WHERE
            UPPER(
              COALESCE(vin, '')
            ) = $1

          OR
            UPPER(
              COALESCE(
                chassis_number,
                ''
              )
            ) = $1

          OR
            UPPER(
              COALESCE(
                model_code,
                ''
              )
            ) = $1

          ORDER BY
            updated_at DESC
          `,
          [query]
        );

      res.json({
        cases:
          result.rows
      });

    } catch (error) {

      console.error(
        "VEHICLE SEARCH ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not search vehicle history."
      });
    }
  }
);

// =====================================
// DTC SEARCH
// =====================================

app.get(
  "/dtc-search/:code",
  async (req, res) => {
    try {
      const code = (req.params.code || "")
        .trim()
        .toUpperCase();

      if (!/^(?:P|B|C|U)[0-9A-F]{4}(?:-[0-9A-F]{2})?$/.test(code)) {
        return res.status(400).json({
          error: "Invalid DTC format."
        });
      }

      const result = await pool.query(
        `
        SELECT
          d.*,
          v.vin,
          v.chassis_number,
          v.model_code,
          v.engine_code,
          v.mileage,
          v.updated_at
        FROM dtc_records d
        LEFT JOIN vehicle_cases v
          ON v.case_id = d.case_id
        WHERE UPPER(COALESCE(d.dtc_code, '')) = $1
        ORDER BY d.created_at DESC
        `,
        [code]
      );

      res.json({
        code,
        count: result.rows.length,
        cases: result.rows
      });
    } catch (error) {
      console.error("DTC SEARCH ERROR:", error);
      res.status(500).json({
        error: "Could not search DTC history."
      });
    }
  }
);

// =====================================
// ASK AI
// =====================================

app.post(
  "/ask",

  upload.single("file"),

  async (
    req,
    res
  ) => {

    let uploadedFilePath =
      null;

    try {

      const question =
        req.body?.question ||
        "";

      const requestedLanguage =
        String(
          req.body?.language ||
          "urdu"
        )
          .trim()
          .toLowerCase();

      const supportedLanguages = {
        urdu: "Urdu",
        english: "English",
        japanese: "Japanese",
        sinhala: "Sinhala"
      };

      const selectedLanguage =
        supportedLanguages[
          requestedLanguage
        ]
          ? requestedLanguage
          : "urdu";

      const responseLanguage =
        supportedLanguages[
          selectedLanguage
        ];

      const previousResponseId =
        req.body?.previousResponseId ||
        "";

      let caseId =
        req.body?.caseId ||
        "";

      if (req.file) {

        uploadedFilePath =
          req.file.path;
      }

      if (
        !question.trim() &&
        !req.file
      ) {

        return res
          .status(400)
          .json({
            error:
              "Please enter a question or upload an image/PDF."
          });
      }

      caseId =
        await ensureCase(
          caseId,
          selectedLanguage
        );

      const content = [];

      if (
        question.trim()
      ) {

        content.push({
          type:
            "input_text",

          text:
            question
        });
      }

      let recordType =
        "text";

      // =================================
      // FILE
      // =================================

      if (req.file) {

        const isImage =
          req.file.mimetype
            .startsWith(
              "image/"
            );

        const isPdf =
          req.file.mimetype ===
          "application/pdf";

        if (isImage) {

          recordType =
            "image";

          const imageBuffer =
            fs.readFileSync(
              req.file.path
            );

          const base64Image =
            imageBuffer.toString(
              "base64"
            );

          content.push({
            type:
              "input_image",

            image_url:
              `data:${req.file.mimetype};base64,${base64Image}`,

            detail:
              "auto"
          });
        }

        if (isPdf) {

          recordType =
            "pdf";

          const pdfBuffer =
            fs.readFileSync(
              req.file.path
            );

          const base64Pdf =
            pdfBuffer.toString(
              "base64"
            );

          let pdfName =
            req.file.originalname ||
            "report.pdf";

          pdfName =
            pdfName.replace(
              /\.PDF$/i,
              ".pdf"
            );

          content.push({
            type:
              "input_file",

            filename:
              pdfName,

            file_data:
              `data:application/pdf;base64,${base64Pdf}`
          });
        }
      }

      // =================================
      // OPENAI
      // =================================

      const requestData = {

        model:
          "gpt-5",

        instructions: `
You are a professional automotive diagnostic AI assistant for a real automotive workshop.

IMPORTANT RESPONSE LANGUAGE:
The user selected ${responseLanguage} as the interface and answer language.
Write the complete human-readable diagnostic answer in ${responseLanguage}.
Do not switch to another language merely because the vehicle report, DTC description, screenshot, PDF, or previous conversation uses another language.
Keep standard automotive abbreviations, DTC codes, VINs, frame/chassis numbers, model codes, engine codes, connector names, scan-tool menu names, and technical values unchanged when appropriate.
For Urdu, write natural Urdu script rather than Hindi/Devanagari.
For Japanese, write natural professional Japanese suitable for an automotive technician.
For Sinhala, write natural Sinhala suitable for an automotive technician.
For English, write clear professional workshop English.

Analyze:
- Questions
- DTCs
- Diagnostic screenshots
- Live data
- Vehicle photographs
- Autel reports
- PDF diagnostic reports

Specialize in:
Honda, Toyota, Nissan, Suzuki, Daihatsu, Isuzu,
Mitsubishi, Mazda, Subaru, Mercedes-Benz and BMW.

IMPORTANT VEHICLE IDENTIFICATION:

Always look for and clearly report:

VIN:
Frame / Chassis Number:
Model Code:
Make:
Model:
Year:
Engine Code:
Transmission:
Mileage:

For Japanese domestic vehicles, do not depend only on a 17-digit VIN.

Frame/chassis numbers such as:
JF3-1234567
NPR85-1234567
MH55S-123456
JH1-1234567

may be the main vehicle identifier.

If a Frame Number, Chassis Number or Model Code appears in a PDF, screenshot, report or user message, clearly show it under VEHICLE IDENTIFICATION.

When analyzing a diagnostic PDF:

STEP 1 — VEHICLE IDENTIFICATION
Extract:
- Make
- Model
- Year
- VIN
- Frame / Chassis Number
- Model Code
- Engine Code
- Transmission
- Mileage
- Report date

STEP 2 — DTC EXTRACTION

List all DTCs with:
- Module
- Code
- Description
- Status
- Priority

STEP 3 — PRIORITY

Classify:
- CRITICAL
- HIGH
- MEDIUM
- LOW / HISTORY

STEP 4 — ROOT CAUSE

Find whether multiple faults may share:
- Battery problem
- Ground
- Power supply
- Fuse
- CAN fault
- Module communication
- Sensor reference voltage

STEP 5 — WORKSHOP TESTS

Give tests in diagnostic order.

STEP 6 — LIVE DATA

Tell technician exactly which live-data values to send next.

STEP 7 — WIRING

Never invent:
- Pins
- Connector numbers
- Fuse numbers
- Wire colors

STEP 8 — FINAL SUMMARY

Finish with:

Most likely root cause:
...

Check first:
1.
2.
3.

Do not replace yet:
...

Next live data to send me:
...

IMPORTANT DATABASE DTC BLOCK:
At the very end of every answer, if one or more DTCs are actually present in the user's message, screenshot, PDF, scan report, or other diagnostic evidence, add this machine-readable block:

DTC RECORDS:
DTC_RECORD: CODE=P0420 | MODULE=ECM | DESCRIPTION=Catalyst System Efficiency Below Threshold Bank 1 | STATUS=Current | PRIORITY=MEDIUM

Use one DTC_RECORD line for each real detected DTC.
Use UNKNOWN for MODULE, DESCRIPTION, STATUS or PRIORITY when that field is not available.
Do NOT put hypothetical, example, comparison, possible-future, or suggested DTC codes in the DTC RECORDS block.
Only include codes that are actually present in the user's diagnostic evidence.

LANGUAGE RULE FOR DATABASE BLOCK:
The DTC RECORDS machine-readable block must keep the exact field labels
DTC RECORDS, DTC_RECORD, CODE, MODULE, DESCRIPTION, STATUS and PRIORITY in English
so the existing database parser continues to work.
The DESCRIPTION value may be written in ${responseLanguage}, but keep the machine-readable separators and field names unchanged.
`,

        input: [
          {
            role:
              "user",

            content:
              content
          }
        ]
      };

      if (
        previousResponseId
      ) {

        requestData
          .previous_response_id =
          previousResponseId;
      }

      const response =
        await openai
          .responses
          .create(
            requestData
          );

      // =================================
      // AUTOMATIC VEHICLE DATA EXTRACTION
      // =================================

      const combinedText =
        question +
        "\n" +
        response.output_text;

      const extractedData =
        extractVehicleData(
          combinedText
        );

      try {

        await updateVehicleIdentity(
          caseId,
          extractedData
        );

      } catch (
        identityError
      ) {

        console.error(
          "VEHICLE ID SAVE ERROR:",
          identityError
        );
      }

      // =================================
      // AUTOMATIC DTC EXTRACTION + SAVE
      // =================================

      const detectedDtcs = extractDtcDetails(
        question,
        response.output_text
      );

      try {
        await saveDtcRecords(
          caseId,
          detectedDtcs,
          combinedText
        );

        if (detectedDtcs.length > 0) {
          console.log(
            "DTC records saved/enriched:",
            caseId,
            detectedDtcs.map((item) => item.code).join(", ")
          );
        }
      } catch (dtcError) {
        console.error(
          "DTC SAVE ERROR:",
          dtcError
        );
      }

      // =================================
      // SAVE HISTORY
      // =================================

      try {

        await saveDiagnosticRecord({
          caseId,

          question,

          answer:
            response.output_text,

          fileName:
            req.file
              ? req.file.originalname
              : null,

          responseId:
            response.id,

          recordType
        });

        console.log(
          "Diagnostic record saved:",
          caseId
        );

      } catch (
        databaseError
      ) {

        console.error(
          "DATABASE SAVE ERROR:",
          databaseError
        );
      }

      // =================================
      // TEMP FILE CLEANUP
      // =================================

      if (
        uploadedFilePath &&
        fs.existsSync(
          uploadedFilePath
        )
      ) {

        fs.unlinkSync(
          uploadedFilePath
        );
      }

      // =================================
      // RETURN
      // =================================

      res.json({
        answer:
          response.output_text,

        responseId:
          response.id,

        caseId,

        vehicleData:
          extractedData,

        detectedDtcs:
          detectedDtcs.map((item) => item.code),

        language:
          selectedLanguage
      });

    } catch (error) {

      console.error(
        "ASK ERROR:",
        error
      );

      if (
        uploadedFilePath &&
        fs.existsSync(
          uploadedFilePath
        )
      ) {

        fs.unlinkSync(
          uploadedFilePath
        );
      }

      res.status(500).json({
        error:
          error.message ||
          "Server error"
      });
    }
  }
);

// =====================================
// ERROR HANDLER
// =====================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({
      error:
        err.message ||
        "Server error"
    });
  }
);

// =====================================
// SERVER
// =====================================

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {

    console.log(
      `Automotive AI Agent running on port ${PORT}`
    );
  }
);