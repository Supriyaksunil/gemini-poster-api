"use strict";

// ============================================================
//  Gemini Poster Bot API  v11.0  â€” Automated Google Login
//  Logs into Gemini automatically using credentials
// ============================================================

const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

puppeteer.use(StealthPlugin());

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  CONFIG
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CFG = {
  PORT: process.env.PORT || 3000,
  GEMINI_BASE: "https://gemini.google.com/app",
  LOGOS_DIR: path.join(__dirname, "logos"),
  LOGOS: { white: "ai360d.png", blue: "ai360d.png", black: "ai360d.png" },
  OUTPUT_DIR: path.join(__dirname, "output"),
  SESSION_TTL_MS: 7200000,
  CHROME_PORT: 9222,
  USER_DATA_DIR: path.join(__dirname, "chrome-profile"),
  CHROME_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
};



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  INIT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/output", express.static(CFG.OUTPUT_DIR));
app.use("/debug_screenshots", express.static(CFG.OUTPUT_DIR));

if (!fs.existsSync(CFG.LOGOS_DIR)) fs.mkdirSync(CFG.LOGOS_DIR, { recursive: true });
if (!fs.existsSync(CFG.OUTPUT_DIR)) fs.mkdirSync(CFG.OUTPUT_DIR, { recursive: true });

const sessions = new Map();
let browser = null;
let chromeProc = null;
let chromePid = null;
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  COOKIE LOADER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  COOKIE LOADER (handles both JSON and Netscape)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const loadCookies = () => {
  try {
    // Try loading from gemini-cookies.json first
    const cookiePath = path.join(__dirname, "gemini-cookies.json");
    if (fs.existsSync(cookiePath)) {
      const content = fs.readFileSync(cookiePath, "utf8").trim();
      
      // Check if it's Netscape format (starts with #)
      if (content.startsWith("#")) {
        console.log("[Cookies] Detected Netscape format, parsing...");
        return parseNetscapeCookies(content);
      }
      
      // Otherwise parse as JSON
      const cookies = JSON.parse(content);
      console.log(`[Cookies] Loaded ${cookies.length} cookies from gemini-cookies.json (JSON)`);
      return cookies;
    }
  } catch (e) {
    console.log("[Cookies] Failed to load gemini-cookies.json:", e.message);
  }
  
  return [];
};

const parseNetscapeCookies = (cookieString) => {
  const cookies = [];
  const lines = cookieString.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0].startsWith(".") ? parts[0] : "." + parts[0],
        path: parts[2],
        secure: parts[3] === "TRUE",
        expires: parseInt(parts[4]) || Math.floor(Date.now() / 1000) + 86400,
        name: parts[5],
        value: parts[6],
      });
    }
  }
  return cookies;
};
const setGeminiCookies = async (page) => {
  const cookies = loadCookies();
  if (!cookies.length) {
    console.log("[Cookies] No cookies found");
    return false;
  }

  console.log(`[Cookies] Setting ${cookies.length} cookies...`);
  
  for (const cookie of cookies) {
    try {
      await page.setCookie({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: cookie.secure || true,
        expires: cookie.expires || (Math.floor(Date.now() / 1000) + 86400),
      });
    } catch (e) {
      console.log(`[Cookies] Failed to set ${cookie.name}: ${e.message}`);
    }
  }
  
  console.log("[Cookies] Cookies set âœ“");
  return true;
};
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  UTILITIES
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  CHROME LIFECYCLE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const killChrome = async () => {
  if (chromePid) {
    try { process.kill(chromePid, "SIGKILL"); } catch {}
    chromePid = null;
    chromeProc = null;
  }
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
  await sleep(1500);
};

const launchChrome = async () => {
  if (!fs.existsSync(CFG.USER_DATA_DIR))
    fs.mkdirSync(CFG.USER_DATA_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${CFG.CHROME_PORT}`,
    `--user-data-dir=${CFG.USER_DATA_DIR}`,
    "--headless=new",
    "--window-size=1920,1080",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
    "--disable-notifications",
    "--disable-popup-blocking",
  ];

  console.log("[Chrome] Launching headless Chrome...");
  chromeProc = require("child_process").spawn(CFG.CHROME_PATH, args, {
    detached: false,
    stdio: "ignore",
  });
  chromePid = chromeProc.pid;

  chromeProc.on("exit", (code) => {
    console.log(`[Chrome] Process exited (code ${code})`);
    chromeProc = null;
    browser = null;
  });

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://localhost:${CFG.CHROME_PORT}/json/version`);
      if (r.ok) {
        console.log(`[Chrome] Ready (PID ${chromePid})`);
        return;
      }
    } catch {}
  }
  throw new Error("Chrome did not become ready within 30s");
};

const connectBrowser = async () => {
  if (browser) {
    try { await browser.version(); return browser; } catch { browser = null; }
  }
  browser = await puppeteer.connect({
    browserURL: `http://localhost:${CFG.CHROME_PORT}`,
    defaultViewport: null,
    protocolTimeout: 120000,
  });
  browser.on("disconnected", () => {
    console.log("[Browser] Disconnected");
    browser = null;
  });
  return browser;
};

const getPage = async (targetUrl) => {
  const b = await connectBrowser();
  const pages = await b.pages();
  let page = pages.find((p) => p.url().includes(targetUrl.split("/").pop()));
  if (!page) {
    page = pages[0] || await b.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  await page.setViewport({ width: 1280, height: 900 });
  return page;
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GOOGLE LOGIN
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GOOGLE LOGIN (Cookie-based only)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const loginToGoogle = async (page) => {
  console.log("[Login] Setting cookies for Gemini...");

  // Set cookies
  const cookiesSet = await setGeminiCookies(page);
  if (!cookiesSet) {
    throw new Error("No cookies available â€” export cookies from your browser first");
  }

  // Refresh to apply cookies
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  // Check if signed in
  const isSignedIn = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    return !bodyText.includes("Sign in") && 
           !bodyText.includes("Sign in to Gemini") && 
           !bodyText.includes("Couldn't sign you in") &&
           bodyText.includes("Gemini");
  });

  if (!isSignedIn) {
    console.log("[Login] WARNING: Cookies may be expired â€” please re-export from browser");
    // Take screenshot for debugging
    const screenshotPath = path.join(CFG.OUTPUT_DIR, `login_check_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`[Login] Screenshot saved: ${screenshotPath}`);
    
    // Still continue â€” sometimes it works after a moment
    await sleep(5000);
    
    const recheck = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return !bodyText.includes("Sign in") && !bodyText.includes("Sign in to Gemini");
    });
    
    if (!recheck) {
      throw new Error("Not signed in â€” cookies expired or invalid");
    }
  }

  console.log("[Login] Signed in with cookies âœ“");
  return true;
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GEMINI HELPERS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const waitForInput = (page, timeout = 30000) =>
  page.waitForSelector('div[contenteditable="true"]', { visible: true, timeout });

const pastePrompt = async (page, prompt) => {
  const inputSelector = 'div[contenteditable="true"]';
  await page.waitForSelector(inputSelector, { visible: true, timeout: 30000 });
  await page.click(inputSelector);
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.evaluate((text) => {
    const el = document.querySelector('div[contenteditable="true"]');
    el.focus();
    document.execCommand("insertText", false, text);
  }, prompt);
};

const waitForChatUrl = async (page, previousUrl, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== previousUrl && url.length > previousUrl.length + 5 && !url.endsWith("/app")) {
      return url;
    }
    await sleep(500);
  }
  return page.url();
};

const snapshotAllImgSrcs = (page) =>
  page.evaluate(() => [...document.querySelectorAll("img")].map((i) => i.src).filter(Boolean));

const extractImageAsBase64 = async (page, src) => {
  if (src.startsWith("data:")) return src;
  if (src.startsWith("blob:")) {
    return page.evaluate(async (s) => {
      const r = await fetch(s);
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return "data:image/png;base64," + btoa(b64);
    }, src);
  }
  return page.evaluate(async (s) => {
    const r = await fetch(s, { credentials: "include" });
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const ct = r.headers.get("content-type") || "image/jpeg";
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:${ct};base64,` + btoa(b64);
  }, src);
};

const waitForNewImage = async (page, knownSrcs, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs;
  const knownSet = new Set(knownSrcs);

  console.log(`[waitForNewImage] Starting â€” known=${knownSrcs.length}, timeout=${timeoutMs / 1000}s`);

  await page.evaluate(() => {
    window.__newImgSrc = null;
    window.__mutObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node) continue;
          const imgs = node.tagName === "IMG" ? [node] : node.querySelectorAll ? [...node.querySelectorAll("img")] : [];
          for (const img of imgs) {
            const src = img.src || "";
            if (src && (src.includes("googleusercontent") || src.includes("usercontent.google") || src.startsWith("blob:"))) {
              window.__newImgSrc = src;
            }
          }
        }
      }
    });
    window.__mutObs.observe(document.body, { childList: true, subtree: true });
  });

  while (Date.now() < deadline) {
    await sleep(1000);
    if (page.isClosed()) break;

    try {
      const result = await page.evaluate((known, minDim) => {
        const mutSrc = window.__newImgSrc;
        if (mutSrc && !known.includes(mutSrc)) return { src: mutSrc, via: "mutation" };
        for (const img of document.querySelectorAll("img")) {
          const src = img.src;
          if (!src || known.includes(src)) continue;
          if (src.includes("googleusercontent") || src.includes("usercontent.google") || src.startsWith("blob:") || src.startsWith("data:image")) {
            const rect = img.getBoundingClientRect();
            const w = rect.width || img.naturalWidth || img.width;
            const h = rect.height || img.naturalHeight || img.height;
            if (w >= minDim && h >= minDim) return { src, via: "dom", w, h };
          }
        }
        return null;
      }, [...knownSet], 100);

      if (result) {
        console.log(`[waitForNewImage] Found: ${result.src.substring(0, 70)}`);
        await sleep(2000);
        return extractImageAsBase64(page, result.src);
      }
    } catch {}
  }

  throw new Error(`No image in ${timeoutMs / 1000}s`);
};

const saveImage = (dataUrl, label) => {
  const safe = label.replace(/[^a-zA-Z0-9]/g, "_");
  const file = path.join(CFG.OUTPUT_DIR, `${safe}_${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
  return file;
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  IMAGE PROCESSING
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const sharp = require("sharp");
    const { data } = await sharp(imgPath).raw().toBuffer({ resolveWithObject: true });
    let total = 0, n = 0;
    for (let i = 0; i < data.length; i += 40) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    return total / n < 128 ? "dark" : "light";
  } catch { return "light"; }
};

const overlayLogo = async (imgPath, logoPath, outPath, opts = {}) => {
  const sharp = require("sharp");
  const { position = "top-right", logoScale = 0.22, maxLogoW = 360, padding = 0 } = opts;
  const { width, height } = await sharp(imgPath).metadata();
  const lw = Math.min(Math.round(width * logoScale), maxLogoW);
  const buf = await sharp(logoPath).resize(lw, null, { withoutEnlargement: true }).toBuffer();
  const px = Math.round(width * padding);
  let left, top;
  switch (position) {
    case "top-right": left = width - lw; top = 0; break;
    case "bottom-left": left = px; top = height - lw * 0.5 - px; break;
    case "bottom-right": left = width - lw - px; top = height - lw * 0.5 - px; break;
    default: left = px; top = px;
  }
  await sharp(imgPath).composite([{ input: buf, left: Math.round(left), top: Math.round(top) }]).toFile(outPath);
  return outPath;
};

const pickLogo = (brightness, logos, preferred) => {
  if (preferred && logos[preferred]) return logos[preferred];
  return brightness === "dark" ? logos.white || logos.blue || logos.black : logos.blue || logos.black || logos.white;
};

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /generate_prompt
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/generate_prompt", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  console.log("\n=== /generate_prompt ===");

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: "prompt required" });

    await killChrome();
    await launchChrome();

    const page = await getPage(CFG.GEMINI_BASE);

    // Login
    await loginToGoogle(page);

    await waitForInput(page, 35000);
    await sleep(600);

    const previousUrl = page.url();
    await pastePrompt(page, prompt);
    await page.keyboard.press("Enter");
    console.log("[generate_prompt] Enter pressed âœ“");

    const chatUrl = await waitForChatUrl(page, previousUrl, 60000);
    if (!chatUrl || chatUrl === CFG.GEMINI_BASE)
      throw new Error("Chat URL did not change");

    console.log(`[generate_prompt] Chat URL: ${chatUrl}`);

    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(sessionId, { chatUrl, originalPrompt: prompt, createdAt: Date.now() });

    console.log(`[generate_prompt] Done â†’ session ${sessionId}`);
    res.json({ success: true, session_id: sessionId, chat_url: chatUrl });

  } catch (err) {
    console.error("[generate_prompt] ERROR:", err.message);
    await killChrome();
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /generate
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/generate", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  console.log("\n=== /generate ===");

  try {
    const { session_id, second_prompt, company_name } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: "session_id required" });

    const session = sessions.get(session_id);
    if (!session) return res.status(404).json({ success: false, error: "Session not found" });

    const safeName = (company_name || "Poster").replace(/[^a-zA-Z0-9]/g, "_");

    // Reconnect to existing browser or launch new
    if (!browser) {
      console.log("[generate] Browser disconnected, reconnecting...");
      await launchChrome();
    }

    const page = await getPage(session.chatUrl);
    await page.goto(session.chatUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForInput(page, 30000);

    const knownSrcs = await snapshotAllImgSrcs(page);
    console.log(`[generate] Known images: ${knownSrcs.length}`);

    const imagePromise = waitForNewImage(page, knownSrcs, 180000);
    await sleep(200);

    const fullPrompt = `${session.originalPrompt}\n\nAdditional instructions: ${second_prompt || "Generate the image."}`;

    await pastePrompt(page, fullPrompt);
    await page.keyboard.press("Enter");
    console.log("[generate] Enter pressed âœ“");
    
    // DEBUG: Screenshot after sending prompt
    const afterPromptPath = path.join(CFG.OUTPUT_DIR, `debug_after_prompt_${Date.now()}.png`);
    await page.screenshot({ path: afterPromptPath });
    console.log(`[generate] Debug screenshot: ${afterPromptPath}`);

    let dataUrl;
    try {
      dataUrl = await imagePromise;
    } catch (e) {
      console.log(`[generate] Image detection failed: ${e.message}`);
      const failPath = path.join(CFG.OUTPUT_DIR, `debug_image_fail_${Date.now()}.png`);
      await page.screenshot({ path: failPath, fullPage: true });
      console.log(`[generate] Fail screenshot: ${failPath}`);
      throw e;
    }
    console.log("[generate] Image received âœ“");

    const imgPath = saveImage(dataUrl, safeName);
    const brightness = await imageBrightness(imgPath);
    const finalUrl = page.url();

    sessions.delete(session_id);

    res.json({
      success: true,
      image_base64: dataUrl,
      brightness: brightness,
      filename: path.basename(imgPath),
      download_url: `/output/${path.basename(imgPath)}`,
      chat_url: finalUrl,
    });

    console.log("[generate] Done âœ“");

  } catch (err) {
    console.error("[generate] ERROR:", err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  } finally {
    await killChrome();
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /addlogo
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/addlogo", async (req, res) => {
  req.setTimeout(60000);
  try {
    const { image_url, image_base64, preferred_logo, position = "top-right", logo_scale = 0.22 } = req.body;
    if (!image_url && !image_base64) return res.status(400).json({ success: false, error: "image_url or image_base64 required" });

    const ts = Date.now();
    const inPath = path.join(CFG.OUTPUT_DIR, `in_${ts}.png`);
    const outPath = path.join(CFG.OUTPUT_DIR, `logo_${ts}.png`);

    if (image_base64) {
      fs.writeFileSync(inPath, Buffer.from(image_base64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    } else {
      const mod = image_url.startsWith("https") ? require("https") : require("http");
      await new Promise((resolve, reject) => {
        const f = fs.createWriteStream(inPath);
        mod.get(image_url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          res.pipe(f);
          f.on("finish", () => { f.close(); resolve(); });
        }).on("error", reject);
      });
    }

    const logos = getLogoPaths();
    const brightness = await imageBrightness(inPath);
    const logoPath = pickLogo(brightness, logos, preferred_logo);
    if (!logoPath) throw new Error("No logo file found");

    await overlayLogo(inPath, logoPath, outPath, { position, logoScale: logo_scale });
    fs.unlinkSync(inPath);

    const finalBuffer = fs.readFileSync(outPath);
    const finalBase64 = finalBuffer.toString("base64");

    res.json({
      success: true,
      image_base64: `data:image/png;base64,${finalBase64}`,
      filename: path.basename(outPath),
      download_url: `/output/${path.basename(outPath)}`,
    });
  } catch (err) {
    console.error("[addlogo] ERROR:", err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GET /debug_screenshots
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/debug_screenshots", (req, res) => {
  try {
    if (!fs.existsSync(CFG.OUTPUT_DIR)) return res.json({ success: true, screenshots: [], count: 0 });
    const files = fs.readdirSync(CFG.OUTPUT_DIR)
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GET /status
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/status", (req, res) => {
  res.json({ success: true, status: "running", version: "11.0-auto-login", timestamp: new Date().toISOString() });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  START SERVER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = app.listen(CFG.PORT, "0.0.0.0", () => {
  console.log("===========================================");
  console.log("  Gemini Poster Bot API  v11.0 (Auto-Login)");
  console.log(`  Listening on http://0.0.0.0:${CFG.PORT}`);
  console.log("===========================================");
});

server.keepAliveTimeout = 620000;
server.headersTimeout = 620000;
