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
  console.log("[Login] Checking chrome-profile session...");

  // Navigate to Gemini first to check if profile is already logged in
  await page.goto(CFG.GEMINI_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  const isProfileLoggedIn = await page.evaluate(() => {
    const t = document.body.innerText;
    return !t.includes("Sign in") && !t.includes("Sign in to Gemini") && !t.includes("Couldn't sign you in") && t.includes("Gemini");
  });

  if (isProfileLoggedIn) {
    console.log("[Login] Already signed in via chrome-profile ✓");
    return true;
  }

  console.log("[Login] Profile not authenticated, trying cookies.txt...");

  // Set cookies from cookies.txt
  const cookiesSet = await setGeminiCookies(page);
  if (!cookiesSet) {
    throw new Error("No cookies available - export cookies from your browser first");
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
    console.log("[Login] WARNING: Cookies may be expired - please re-export from browser");
    const screenshotPath = path.join(CFG.OUTPUT_DIR, `login_check_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`[Login] Screenshot saved: ${screenshotPath}`);

    await sleep(5000);

    const recheck = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return !bodyText.includes("Sign in") && !bodyText.includes("Sign in to Gemini");
    });

    if (!recheck) {
      throw new Error("Not signed in - cookies expired or invalid");
    }
  }

  console.log("[Login] Signed in with cookies ✓");
  return true;
};