"use strict";

// ============================================================
//  Gemini Poster Bot API  v9.1  — API-Based with Two-Step Flow
//  /generate_prompt → stores prompt, returns session_id
//  /generate → uses session to generate image
// ============================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const sharp = require("sharp");

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CFG = {
  PORT: process.env.PORT || 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  LOGOS_DIR: path.join(__dirname, "logos"),
  LOGOS: { white: "ai360d.png", blue: "ai360d.png", black: "ai360d.png" },
  OUTPUT_DIR: path.join(__dirname, "output"),
  SESSION_TTL_MS: 7200000, // 2 hours
};

// Validate API key
if (!CFG.GEMINI_API_KEY) {
  console.error("❌ ERROR: GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Static file serving
app.use("/output", express.static(CFG.OUTPUT_DIR));
app.use("/debug_screenshots", express.static(CFG.OUTPUT_DIR));

// Create directories
if (!fs.existsSync(CFG.LOGOS_DIR)) fs.mkdirSync(CFG.LOGOS_DIR, { recursive: true });
if (!fs.existsSync(CFG.OUTPUT_DIR)) fs.mkdirSync(CFG.OUTPUT_DIR, { recursive: true });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(CFG.GEMINI_API_KEY);

// Session storage
const sessions = new Map();

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const saveBase64Image = (base64Data, label) => {
  const safe = label.replace(/[^a-zA-Z0-9]/g, "_");
  const file = path.join(CFG.OUTPUT_DIR, `${safe}_${Date.now()}.png`);
  const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
  fs.writeFileSync(file, Buffer.from(cleanBase64, "base64"));
  return file;
};

const downloadImage = (src, destPath) =>
  new Promise((resolve, reject) => {
    if (src.startsWith("data:")) {
      const clean = src.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(destPath, Buffer.from(clean, "base64"));
      return resolve();
    }
    const mod = src.startsWith("https") ? require("https") : require("http");
    const f = fs.createWriteStream(destPath);
    mod
      .get(src, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode}`));
        res.pipe(f);
        f.on("finish", () => {
          f.close();
          resolve();
        });
      })
      .on("error", reject);
  });

// ─────────────────────────────────────────────
//  IMAGE PROCESSING
// ─────────────────────────────────────────────
const getLogoPaths = () => {
  const r = {};
  for (const [k, f] of Object.entries(CFG.LOGOS)) {
    const p = path.join(CFG.LOGOS_DIR, f);
    r[k] = fs.existsSync(p) ? p : null;
  }
  return r;
};

const imageBrightness = async (imgPath) => {
  try {
    const { data } = await sharp(imgPath)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let total = 0, n = 0;
    for (let i = 0; i < data.length; i += 40) {
      total +=
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    return total / n < 128 ? "dark" : "light";
  } catch {
    return "light";
  }
};

const overlayLogo = async (imgPath, logoPath, outPath, opts = {}) => {
  const {
    position = "top-right",
    logoScale = 0.22,
    maxLogoW = 360,
    padding = 0,
  } = opts;
  const { width, height } = await sharp(imgPath).metadata();
  const lw = Math.min(Math.round(width * logoScale), maxLogoW);
  const buf = await sharp(logoPath)
    .resize(lw, null, { withoutEnlargement: true })
    .toBuffer();
  const px = Math.round(width * padding);
  let left, top;
  switch (position) {
    case "top-right":
      left = width - lw;
      top = 0;
      break;
    case "bottom-left":
      left = px;
      top = height - lw * 0.5 - px;
      break;
    case "bottom-right":
      left = width - lw - px;
      top = height - lw * 0.5 - px;
      break;
    case "center":
      left = Math.round((width - lw) / 2);
      top = Math.round((height - lw * 0.5) / 2);
      break;
    default:
      left = px;
      top = px;
  }
  await sharp(imgPath)
    .composite([{ input: buf, left: Math.round(left), top: Math.round(top) }])
    .toFile(outPath);
  return outPath;
};

const pickLogo = (brightness, logos, preferred) => {
  if (preferred && logos[preferred]) return logos[preferred];
  return brightness === "dark"
    ? logos.white || logos.blue || logos.black
    : logos.blue || logos.black || logos.white;
};

// ─────────────────────────────────────────────
//  CORE: GENERATE IMAGE WITH GEMINI API
// ─────────────────────────────────────────────
async function generateImageWithGemini(prompt, modelName = "gemini-2.0-flash-exp-image-generation") {
  console.log(`[Gemini API] Generating image...`);
  console.log(`[Gemini API] Prompt: ${prompt.substring(0, 100)}...`);

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseModalities: ["Text", "Image"],
      temperature: 1,
      topP: 0.95,
      topK: 40,
    },
  });

  const result = await model.generateContent(prompt);
  const response = await result.response;

  let imageData = null;
  let textResponse = "";

  for (const candidate of response.candidates) {
    if (candidate.content && candidate.content.parts) {
      for (const part of candidate.content.parts) {
        if (part.inlineData) {
          imageData = part.inlineData.data;
        } else if (part.text) {
          textResponse += part.text;
        }
      }
    }
  }

  if (!imageData) {
    throw new Error(`No image generated. Text response: ${textResponse}`);
  }

  return { imageBase64: imageData, text: textResponse };
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
//  POST /generate_prompt  (Step 1: Store prompt, return session)
// ─────────────────────────────────────────────
app.post("/generate_prompt", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  console.log("\n=== /generate_prompt ===");

  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ success: false, error: "prompt required" });
    }

    // Create session
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const chatUrl = `https://gemini.google.com/app/${Math.random().toString(36).slice(2, 16)}`;

    sessions.set(sessionId, {
      chatUrl,
      originalPrompt: prompt,
      createdAt: Date.now(),
    });

    console.log(`[generate_prompt] Session created: ${sessionId}`);
    console.log(`[generate_prompt] Chat URL: ${chatUrl}`);

    res.json({
      success: true,
      session_id: sessionId,
      chat_url: chatUrl,
    });

    console.log("[generate_prompt] Done ✓");

  } catch (err) {
    console.error("[generate_prompt] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  POST /generate  (Step 2: Generate image using session)
// ─────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  console.log("\n=== /generate ===");

  try {
    const { session_id, second_prompt, company_name } = req.body;

    if (!session_id) {
      return res.status(400).json({ success: false, error: "session_id required" });
    }

    const session = sessions.get(session_id);
    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found or expired" });
    }

    // Combine prompts: original + second prompt
    const fullPrompt = `${session.originalPrompt}\n\nAdditional instructions: ${second_prompt || "Generate the image as described above."}`;
    const safeName = (company_name || "Poster").replace(/[^a-zA-Z0-9]/g, "_");

    console.log(`[generate] Using session: ${session_id}`);
    console.log(`[generate] Combined prompt length: ${fullPrompt.length}`);

    // Generate image
    const { imageBase64, text } = await generateImageWithGemini(fullPrompt);

    // Save to disk
    const imgPath = saveBase64Image(imageBase64, safeName);
    console.log(`[generate] Image saved: ${imgPath}`);

    // Determine brightness for logo
    const brightness = await imageBrightness(imgPath);

    // Clean up session
    sessions.delete(session_id);
    console.log(`[generate] Session ${session_id} removed`);

    res.json({
      success: true,
      image_base64: `data:image/png;base64,${imageBase64}`,
      text: text,
      brightness: brightness,
      filename: path.basename(imgPath),
      download_url: `/output/${path.basename(imgPath)}`,
      chat_url: session.chatUrl,
    });

    console.log("[generate] Done ✓");

  } catch (err) {
    console.error("[generate] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  POST /generate_with_logo  (Single-step: generate + logo)
// ─────────────────────────────────────────────
app.post("/generate_with_logo", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  console.log("\n=== /generate_with_logo ===");

  try {
    const { prompt, company_name, preferred_logo, position, logo_scale } = req.body;
    if (!prompt) {
      return res.status(400).json({ success: false, error: "prompt required" });
    }

    const safeName = (company_name || "Poster").replace(/[^a-zA-Z0-9]/g, "_");

    // Generate image
    const { imageBase64, text } = await generateImageWithGemini(prompt);

    // Save temp image
    const tempPath = path.join(CFG.OUTPUT_DIR, `temp_${Date.now()}.png`);
    fs.writeFileSync(tempPath, Buffer.from(imageBase64, "base64"));

    // Add logo
    const logos = getLogoPaths();
    const brightness = await imageBrightness(tempPath);
    const logoPath = pickLogo(brightness, logos, preferred_logo);

    if (!logoPath) {
      fs.unlinkSync(tempPath);
      throw new Error("No logo file found — check logos/ folder");
    }

    const outPath = path.join(CFG.OUTPUT_DIR, `${safeName}_${Date.now()}.png`);
    await overlayLogo(tempPath, logoPath, outPath, {
      position: position || "top-right",
      logoScale: logo_scale || 0.22,
    });

    fs.unlinkSync(tempPath);

    // Read final image as base64
    const finalBuffer = fs.readFileSync(outPath);
    const finalBase64 = finalBuffer.toString("base64");

    res.json({
      success: true,
      image_base64: `data:image/png;base64,${finalBase64}`,
      text: text,
      brightness: brightness,
      filename: path.basename(outPath),
      download_url: `/output/${path.basename(outPath)}`,
    });

    console.log("[generate_with_logo] Done ✓");

  } catch (err) {
    console.error("[generate_with_logo] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  POST /edit  (Edit existing image)
// ─────────────────────────────────────────────
app.post("/edit", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  console.log("\n=== /edit ===");

  try {
    const { image_base64, correction_prompt, company_name } = req.body;
    if (!image_base64) {
      return res.status(400).json({ success: false, error: "image_base64 required" });
    }
    if (!correction_prompt) {
      return res.status(400).json({ success: false, error: "correction_prompt required" });
    }

    const safeName = (company_name || "EditPoster").replace(/[^a-zA-Z0-9]/g, "_");

    const fullPrompt = `Here is an image I generated earlier. Please edit it based on this request: ${correction_prompt}`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp-image-generation",
      generationConfig: {
        responseModalities: ["Text", "Image"],
      },
    });

    const cleanBase64 = image_base64.replace(/^data:image\/\w+;base64,/, "");
    const imagePart = {
      inlineData: {
        data: cleanBase64,
        mimeType: "image/png",
      },
    };

    const result = await model.generateContent([fullPrompt, imagePart]);
    const response = await result.response;

    let imageData = null;
    let textResponse = "";

    for (const candidate of response.candidates) {
      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            imageData = part.inlineData.data;
          } else if (part.text) {
            textResponse += part.text;
          }
        }
      }
    }

    if (!imageData) {
      throw new Error(`No edited image generated. Text: ${textResponse}`);
    }

    const imgPath = saveBase64Image(imageData, safeName);
    const brightness = await imageBrightness(imgPath);

    res.json({
      success: true,
      image_base64: `data:image/png;base64,${imageData}`,
      text: textResponse,
      brightness: brightness,
      filename: path.basename(imgPath),
      download_url: `/output/${path.basename(imgPath)}`,
    });

    console.log("[edit] Done ✓");

  } catch (err) {
    console.error("[edit] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  POST /verify_poster  (Analyze image)
// ─────────────────────────────────────────────
app.post("/verify_poster", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  console.log("\n=== /verify_poster ===");

  try {
    const { verify_prompt, image_url, image_base64 } = req.body;
    if (!verify_prompt) {
      return res.status(400).json({ success: false, error: "verify_prompt required" });
    }
    if (!image_url && !image_base64) {
      return res.status(400).json({ success: false, error: "image_url or image_base64 required" });
    }

    let imageData;
    if (image_base64) {
      imageData = image_base64.replace(/^data:image\/\w+;base64,/, "");
    } else {
      const tempPath = path.join(CFG.OUTPUT_DIR, `verify_${Date.now()}.png`);
      await downloadImage(image_url, tempPath);
      imageData = fs.readFileSync(tempPath).toString("base64");
      fs.unlinkSync(tempPath);
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const imagePart = {
      inlineData: {
        data: imageData,
        mimeType: "image/png",
      },
    };

    const result = await model.generateContent([verify_prompt, imagePart]);
    const response = await result.response;
    const analysis = response.text();

    res.json({
      success: true,
      analysis: analysis,
    });

    console.log("[verify_poster] Done ✓");

  } catch (err) {
    console.error("[verify_poster] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  POST /addlogo  (Overlay logo)
// ─────────────────────────────────────────────
app.post("/addlogo", async (req, res) => {
  req.setTimeout(60000);

  try {
    const {
      image_url,
      image_base64,
      preferred_logo,
      position = "top-right",
      logo_scale = 0.22,
    } = req.body;

    if (!image_url && !image_base64) {
      return res.status(400).json({
        success: false,
        error: "image_url or image_base64 required",
      });
    }

    const ts = Date.now();
    const inPath = path.join(CFG.OUTPUT_DIR, `in_${ts}.png`);
    const outPath = path.join(CFG.OUTPUT_DIR, `logo_${ts}.png`);

    await downloadImage(image_url || image_base64, inPath);

    const logos = getLogoPaths();
    const brightness = await imageBrightness(inPath);
    const logoPath = pickLogo(brightness, logos, preferred_logo);

    if (!logoPath) throw new Error("No logo file found — check logos/ folder");

    await overlayLogo(inPath, logoPath, outPath, {
      position,
      logoScale: logo_scale,
    });
    fs.unlinkSync(inPath);

    const finalBuffer = fs.readFileSync(outPath);
    const finalBase64 = finalBuffer.toString("base64");

    res.json({
      success: true,
      image_base64: `data:image/png;base64,${finalBase64}`,
      filename: path.basename(outPath),
      download_url: `/output/${path.basename(outPath)}`,
    });

    console.log("[addlogo] Done ✓");

  } catch (err) {
    console.error("[addlogo] ERROR:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────
//  GET /status/:session_id  (Check session)
// ─────────────────────────────────────────────
app.get("/status/:session_id", (req, res) => {
  const s = sessions.get(req.params.session_id);
  if (!s) return res.status(404).json({ success: false, error: "Session not found" });
  res.json({
    success: true,
    chat_url: s.chatUrl,
    elapsed_seconds: Math.floor((Date.now() - s.createdAt) / 1000),
  });
});

// ─────────────────────────────────────────────
//  GET /debug_screenshots — List all images
// ─────────────────────────────────────────────
app.get("/debug_screenshots", (req, res) => {
  try {
    if (!fs.existsSync(CFG.OUTPUT_DIR)) {
      return res.json({ success: true, screenshots: [], count: 0 });
    }

    const files = fs
      .readdirSync(CFG.OUTPUT_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({
        filename: f,
        url: `${req.protocol}://${req.get("host")}/output/${f}`,
        size: fs.statSync(path.join(CFG.OUTPUT_DIR, f)).size,
        created: fs.statSync(path.join(CFG.OUTPUT_DIR, f)).mtime,
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ success: true, screenshots: files, count: files.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /output/:filename — Direct image access
// ─────────────────────────────────────────────
app.get("/output/:filename", (req, res) => {
  try {
    const filePath = path.join(CFG.OUTPUT_DIR, req.params.filename);

    if (!filePath.startsWith(CFG.OUTPUT_DIR)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    res.sendFile(filePath, {
      headers: { "Content-Type": "image/png" },
      dotfiles: "deny",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /status — Health check
// ─────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    success: true,
    status: "running",
    version: "9.1-api",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  POST /shutdown
// ─────────────────────────────────────────────
app.post("/shutdown", async (req, res) => {
  sessions.clear();
  res.json({ success: true, message: "Shutdown complete" });
});

// ─────────────────────────────────────────────
//  SESSION EXPIRY (every 5 min)
// ─────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > CFG.SESSION_TTL_MS) {
      sessions.delete(id);
      console.log(`[Cleanup] Expired session ${id}`);
    }
  }
}, 300000);

// ─────────────────────────────────────────────
//  GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Express]", err);
  if (!res.headersSent)
    res.status(500).json({ success: false, error: err.message });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
const server = app.listen(CFG.PORT, "0.0.0.0", () => {
  console.log("===========================================");
  console.log("  Gemini Poster Bot API  v9.1 (API-Based)");
  console.log(`  Listening on http://0.0.0.0:${CFG.PORT}`);
  console.log("===========================================");
});

server.keepAliveTimeout = 620000;
server.headersTimeout = 620000;