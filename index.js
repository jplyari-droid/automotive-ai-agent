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

async function createVehicleCase() {

  const caseId =
    createCaseId();

  await pool.query(
    `
    INSERT INTO vehicle_cases (
      case_id,
      status
    )
    VALUES ($1, 'open')
    `,
    [caseId]
  );

  return caseId;
}

// =====================================
// ENSURE CASE
// =====================================

async function ensureCase(
  caseId
) {

  if (!caseId) {

    return await
      createVehicleCase();
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

    return caseId;
  }

  await pool.query(
    `
    INSERT INTO vehicle_cases (
      case_id,
      status
    )
    VALUES ($1, 'open')
    `,
    [caseId]
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
        /\b([A-Z]{1,6}[0-9]{1,5}-[0-9]{4,10})\b/i
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
      /(?:ENGINE\s*CODE|ENGINE)\s*[:#-]\s*([A-Z0-9-]{2,20})/i
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

      const caseId =
        await
          createVehicleCase();

      res.json({
        success: true,
        caseId
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
          caseId
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

Reply in the same language as the user unless asked otherwise.
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
          extractedData
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