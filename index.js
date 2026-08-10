require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed."));
    }
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/ask", upload.single("image"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    const question = req.body?.question || "";
    const previousResponseId =
      req.body?.previousResponseId || "";

    if (req.file) {
      uploadedFilePath = req.file.path;
    }

    if (!question.trim() && !req.file) {
      return res.status(400).json({
        error: "Please enter a question or upload an image."
      });
    }

    const content = [];

    if (question.trim()) {
      content.push({
        type: "input_text",
        text: question
      });
    }

    if (req.file) {
      const imageBuffer = fs.readFileSync(req.file.path);
      const base64Image = imageBuffer.toString("base64");

      content.push({
        type: "input_image",
        image_url:
          `data:${req.file.mimetype};base64,${base64Image}`,
        detail: "auto"
      });
    }

    const requestData = {
      model: "gpt-5",

      instructions: `
You are a professional automotive diagnostic AI assistant.

Help a professional automotive workshop diagnose vehicles.

Specialize in:
Honda, Toyota, Nissan, Suzuki, Daihatsu, Isuzu,
Mitsubishi, Mazda, Subaru, Mercedes-Benz and BMW.

You can help with:
DTC codes
Engine
Transmission
ABS
SRS
ADAS
BCM
ECU
CAN communication
Immobilizer
Smart keys
DPF
DPD
Hybrid systems
Fuel systems
Electrical diagnosis
Sensors
Actuators
Fuse and relay diagnosis
Wiring diagnosis
Live data
Diagnostic screenshots
Scan-tool photographs

When answering:

1. Explain the fault clearly.
2. Give likely causes in diagnostic order.
3. Give step-by-step workshop tests.
4. Explain multimeter tests when useful.
5. Explain scanner live-data checks.
6. Give specifications only when reliable.
7. Test before recommending parts replacement.
8. Ask for VIN, year, engine code or more data when needed.
9. Do not invent wiring pin numbers.
10. Carefully inspect uploaded images.
11. Remember the previous conversation context.
12. Treat follow-up questions as part of the same diagnostic case.
13. Give practical workshop-focused answers.

Reply in the same language as the user unless asked otherwise.
`,

      input: [
        {
          role: "user",
          content: content
        }
      ]
    };

    if (previousResponseId) {
      requestData.previous_response_id =
        previousResponseId;
    }

    const response =
      await openai.responses.create(requestData);

    if (
      uploadedFilePath &&
      fs.existsSync(uploadedFilePath)
    ) {
      fs.unlinkSync(uploadedFilePath);
    }

    res.json({
      answer: response.output_text,
      responseId: response.id
    });

  } catch (error) {
    console.error(error);

    if (
      uploadedFilePath &&
      fs.existsSync(uploadedFilePath)
    ) {
      fs.unlinkSync(uploadedFilePath);
    }

    res.status(500).json({
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Automotive AI Agent running on port ${PORT}`
  );
});