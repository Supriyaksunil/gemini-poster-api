"use strict";

// ============================================================
//  Gemini Poster Bot API  v8.0
//  Fixes: network-level image detection, listener-before-prompt,
//         120s timeout, MutationObserver + DOM poll fallbacks
// ============================================================

const express         = require("express");
const puppeteer       = require("puppeteer");
const path            = require("path");
const fs              = require("fs");
const cors            = require("cors");
const { spawn, exec } = require("child_process");
const net             = require("net");
const sharp           = require("sharp");

// ─────────────────────────────────────────────
//  GLOBAL STATE — MUST be before session persistence
// ─────────────────────────────────────────────
let chromeProc = null;
let chromePid  = null;
let browser    = null;
const sessions = new Map();

// ─────────────────────────────────────────────
//  SESSION PERSISTENCE
// ─────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

const loadSessions = () => {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [id, s] of Object.entries(data)) {
        sessions.set(id, s);
      }
      console.log(`[Sessions] Loaded ${sessions.size} sessions from disk`);
    }
  } catch (e) {
    console.log('[Sessions] Load failed:', e.message);
  }
};

const saveSessions = () => {
  try {
    const data = Object.fromEntries(sessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('[Sessions] Save failed:', e.message);
  }
};

// Load on startup
loadSessions();
// Save every 30 seconds
setInterval(saveSessions, 30000);

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CFG = {
  CHROME_PORT    : 9222,
  USER_DATA_DIR  : "/tmp/chrome-debug",
  CHROME_PATH    : process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
  LOGOS_DIR      : path.join(__dirname, "logos"),
  LOGOS          : { white: "ai360d.png", blue: "ai360d.png", black: "ai360d.png" },
  IMAGE_WAIT_MS  : 120000,
  POLL_MS        : 3000,
  SESSION_TTL_MS : 7200000
};
// ─── ADD THIS HELPER ───
const takeScreenshot = async (page, label) => {
  try {
    const file = path.join(OUTPUT_DIR, `debug_${label}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false, clip: { x: 0, y: 0, width: 1280, height: 2000 } });
    console.log(`[Debug] 📸 Screenshot: ${file}`);
    return file;
  } catch (e) {
    console.log(`[Debug] Screenshot failed: ${e.message}`);
    return null;
  }
};
// ─────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

if (!fs.existsSync(CFG.LOGOS_DIR)) fs.mkdirSync(CFG.LOGOS_DIR, { recursive: true });
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─────────────────────────────────────────────
//  CHROME MUTEX
// ─────────────────────────────────────────────
let   _busy  = false;
const _queue = [];

const acquireChrome = () => new Promise(resolve => {
  if (!_busy) { _busy = true; resolve(); }
  else        { console.log("[Queue] waiting…"); _queue.push(resolve); }
});

const releaseChrome = () => {
  if (_queue.length) {
    const next = _queue.shift();
    console.log(`[Queue] releasing — ${_queue.length} left`);
    next();
  } else {
    _busy = false;
  }
};

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const portInUse = port => new Promise(resolve => {
  const s = net.createServer()
    .once("error", () => resolve(true))
    .once("listening", () => { s.close(); resolve(false); })
    .listen(port, "127.0.0.1");
});

const execCmd = cmd => new Promise(resolve => exec(cmd, () => resolve()));

const getPidOnPort = port => new Promise(resolve => {
  exec(`lsof -t -i:${port} 2>/dev/null`, (err, stdout) => {
    const pid = parseInt((stdout || "").trim(), 10);
    resolve(isNaN(pid) ? null : pid);
  });
});

// ─────────────────────────────────────────────
//  CHROME LIFECYCLE
// ─────────────────────────────────────────────
const killDebugChrome = async () => {
  if (chromePid) {
    console.log(`[Chrome] Killing debug Chrome PID ${chromePid}`);
    try { process.kill(chromePid, 'SIGKILL'); } catch {}
    chromePid  = null;
    chromeProc = null;
  }

  try {
    const { execSync } = require('child_process');
    const pid = execSync(`lsof -t -i:${CFG.CHROME_PORT} 2>/dev/null`).toString().trim();
    if (pid) {
      console.log(`[Chrome] Killing residual PID ${pid} on port ${CFG.CHROME_PORT}`);
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
    }
  } catch {}

  await sleep(1200);
};

const removeLockFiles = () => {
  const lockFiles = [
    "SingletonLock", "SingletonCookie", "SingletonSocket",
    path.join("Default", "Cookies-journal"),
    path.join("Default", "Lock")
  ];
  for (const rel of lockFiles) {
    try {
      const p = path.join(CFG.USER_DATA_DIR, rel);
      if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[Chrome] Removed lock: ${rel}`); }
    } catch {}
  }
};

const nukeChrome = async () => {
  console.log("[Chrome] Nuking debug Chrome…");
  if (browser) {
    try { await browser.disconnect(); } catch {}
    browser = null;
  }
  await killDebugChrome();
  await sleep(400);
  removeLockFiles();
};

const launchChrome = async (startUrl = "https://gemini.google.com/app") => {
  if (!fs.existsSync(CFG.CHROME_PATH))
    throw new Error(`Chrome binary not found: ${CFG.CHROME_PATH}`);
  if (!fs.existsSync(CFG.USER_DATA_DIR))
    fs.mkdirSync(CFG.USER_DATA_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${CFG.CHROME_PORT}`,
    `--user-data-dir=${CFG.USER_DATA_DIR}`,
     `--headless=new`,  // 🔴 DISABLED FOR VISUAL DEBUGGING
    "--window-size=1920,1080",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",              // Optional: keep or remove for visual mode
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
    startUrl
  ];

  console.log("[Chrome] Launching in VISIBLE mode (non-headless)…");
  chromeProc = spawn(CFG.CHROME_PATH, args, { detached: false, stdio: "ignore" });
  chromePid  = chromeProc.pid;

  chromeProc.on("exit", code => {
    console.log(`[Chrome] Process exited (code ${code})`);
    chromeProc = null;
    browser    = null;
  });

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://localhost:${CFG.CHROME_PORT}/json/version`);
      if (r.ok) { console.log(`[Chrome] Ready (PID ${chromePid})`); return; }
    } catch {}
    console.log(`[Chrome] Waiting ${i + 1}/30…`);
  }
  throw new Error("Chrome did not become ready within 30 s");
};

const ensureChrome = async () => {
  const up = await portInUse(CFG.CHROME_PORT);

  if (up && chromePid) {
    try {
      const r = await fetch(`http://localhost:${CFG.CHROME_PORT}/json/version`);
      if (r.ok) { console.log(`[Chrome] Already running (PID ${chromePid})`); return; }
    } catch {}
    console.log("[Chrome] DevTools not responding — restarting…");
  }

  if (up && !chromePid) {
    console.log("[Chrome] Foreign process on debug port — killing…");
    const portPid = await getPidOnPort(CFG.CHROME_PORT);
    if (portPid) {
      try { process.kill(portPid, 'SIGKILL'); } catch {}
      await sleep(1200);
    }
  }

  await nukeChrome();
  await launchChrome();
};

const connectBrowser = async () => {
  if (browser) {
    try { await browser.version(); return browser; }
    catch { browser = null; }
  }
  browser = await puppeteer.connect({
    browserURL      : `http://localhost:${CFG.CHROME_PORT}`,
    defaultViewport : null,
    protocolTimeout : 120000
  });
  browser.on("disconnected", () => {
    console.log("[Browser] Disconnected");
    browser = null;
  });
  return browser;
};

const getPage = async (targetUrl) => {
  const b     = await connectBrowser();
  const pages = await b.pages();

  let page = pages.find(p => p.url() === targetUrl)
          || pages.find(p => p.url().startsWith(targetUrl));

  if (!page) {
    page = pages[0] || await b.newPage();
    console.log(`[Page] Navigating → ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }

  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  try {
    await b.defaultBrowserContext()
      .overridePermissions("https://gemini.google.com", ["clipboard-read", "clipboard-write"]);
  } catch {}

  return page;
};

// ─────────────────────────────────────────────
//  GEMINI HELPERS
// ─────────────────────────────────────────────
const GEMINI_BASE = "https://gemini.google.com/app";

const waitForInput = (page, timeout = 30000) =>
  page.waitForSelector(
    'textarea, [contenteditable="true"], div[role="textbox"]',
    { visible: true, timeout }
  );

async function pastePrompt(page, prompt) {
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
  console.log("[pastePrompt] Prompt pasted safely ✓");
}

const waitForChatUrl = async (page, previousUrl, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  await page.waitForFunction(
    () => {
      const el = document.querySelector('textarea, [contenteditable="true"], div[role="textbox"]');
      if (!el) return false;
      return (el.tagName === "TEXTAREA" ? el.value : el.textContent).trim().length === 0;
    },
    { timeout: 20000 }
  ).catch(() => {});

  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== previousUrl &&
        url.length > previousUrl.length + 5 &&
        !url.endsWith("/app")) {
      return url;
    }
    await sleep(500);
  }
  return page.url();
};

const snapshotAllImgSrcs = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("img")].map(i => i.src).filter(Boolean)
  );

// ─────────────────────────────────────────────
//  IMAGE EXTRACTION
// ─────────────────────────────────────────────
const extractImageAsBase64 = async (page, src) => {
  if (src.startsWith("data:")) return src;

  if (src.startsWith("blob:")) {
    return page.evaluate(async (s) => {
      const img = [...document.querySelectorAll("img")].find(i => i.src === s);
      if (img) {
        await new Promise((res, rej) => {
          if (img.complete) res();
          else { img.onload = res; img.onerror = () => rej(new Error("img load failed")); }
        });
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/png");
      }
      const r   = await fetch(s);
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let b64 = "";
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return "data:image/png;base64," + btoa(b64);
    }, src);
  }

  return page.evaluate(async (s) => {
    const r     = await fetch(s, { credentials: "include" });
    const buf   = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const ct    = r.headers.get("content-type") || "image/jpeg";
    let b64 = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${ct};base64,` + btoa(b64);
  }, src);
};

// ─────────────────────────────────────────────
//  FINGERPRINTING
// ─────────────────────────────────────────────
const fingerprintImagesInDOM = async (page) => {
  return page.evaluate(() => {
    const results = {};
    for (const img of document.querySelectorAll("img")) {
      const src = img.src;
      if (!src) continue;
      const w = img.naturalWidth  || img.width  || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 10 || h < 10) continue;
      try {
        const c = document.createElement("canvas");
        c.width = 4; c.height = 4;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, 4, 4);
        const d = ctx.getImageData(0, 0, 4, 4).data;
        const hex = (i) => "#" + [d[i], d[i+1], d[i+2]].map(v => v.toString(16).padStart(2,"0")).join("");
        results[src] = `${w}x${h}:${hex(0)}:${hex(4)}:${hex(8)}`;
      } catch {}
    }
    return results;
  });
};

// ─────────────────────────────────────────────
//  waitForNewImageAfterPrompt
// ─────────────────────────────────────────────
const waitForNewImageAfterPrompt = async (page, knownSrcs, promptSentAt, timeoutMs = 120000) => {
  const deadline   = Date.now() + timeoutMs;
  const knownSrcSet = new Set(knownSrcs);

  console.log("[edit] Snapshotting pre-prompt blobs + fingerprints…");

  const preFpMap = await fingerprintImagesInDOM(page);
  const knownFpSet  = new Set(Object.values(preFpMap));
  const knownBlobSet = new Set(
    Object.keys(preFpMap).filter(s => s.startsWith("blob:"))
  );

  const allPreSrcs = await page.evaluate(() =>
    [...document.querySelectorAll("img")].map(i => i.src).filter(Boolean)
  );
  for (const s of allPreSrcs) knownSrcSet.add(s);

  console.log(`[waitForNewImageAfterPrompt] Pre-prompt: srcs=${knownSrcSet.size}, blobs=${knownBlobSet.size}, fps=${knownFpSet.size}`);

  const blockCountBefore = await page.evaluate(() =>
    document.querySelectorAll(
      "model-response, message-content, [data-response-index], [class*='model-response'], response-element"
    ).length
  );
  console.log(`[waitForNewImageAfterPrompt] Blocks before: ${blockCountBefore}`);

  console.log("[waitForNewImageAfterPrompt] Waiting for new response block…");
  try {
    await page.waitForFunction((before) =>
      document.querySelectorAll(
        "model-response, message-content, [data-response-index], [class*='model-response'], response-element"
      ).length > before,
    { timeout: 45000 }, blockCountBefore);
    console.log("[waitForNewImageAfterPrompt] New response block ✓");
  } catch {
    console.log("[waitForNewImageAfterPrompt] Response block timeout — continuing");
  }

  console.log("[waitForNewImageAfterPrompt] Waiting for input to be disabled (generation started)…");
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('div[contenteditable="true"]');
      if (!el) return false;
      return (
        el.getAttribute("aria-disabled") === "true" ||
        el.closest("[aria-disabled='true']") !== null ||
        el.getAttribute("contenteditable") === "false" ||
        !!document.querySelector("button[aria-label*='Stop' i]") ||
        !!document.querySelector("button[aria-label*='Cancel' i]") ||
        !!document.querySelector("pendulum-spinner") ||
        !!document.querySelector("loading-indicator") ||
        !!document.querySelector("[data-is-streaming='true']")
      );
    }, { timeout: 20000 });
    console.log("[waitForNewImageAfterPrompt] Generation in progress ✓");
  } catch {
    console.log("[waitForNewImageAfterPrompt] Disabled signal not seen — continuing");
  }

  console.log("[waitForNewImageAfterPrompt] Waiting for input re-enabled (generation done)…");
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('div[contenteditable="true"]');
      if (!el) return false;
      const notDisabled =
        el.getAttribute("aria-disabled") !== "true" &&
        el.closest("[aria-disabled='true']") === null &&
        el.getAttribute("contenteditable") !== "false";
      const noSpinner =
        !document.querySelector("button[aria-label*='Stop' i]") &&
        !document.querySelector("button[aria-label*='Cancel' i]") &&
        !document.querySelector("pendulum-spinner") &&
        !document.querySelector("loading-indicator") &&
        !document.querySelector("[data-is-streaming='true']");
      return notDisabled && noSpinner;
    }, { timeout: 110000 });
    console.log("[waitForNewImageAfterPrompt] Input re-enabled — generation complete ✓");
  } catch {
    console.log("[waitForNewImageAfterPrompt] Re-enable signal not seen — continuing");
  }

  console.log("[waitForNewImageAfterPrompt] Settling 3s for blob render…");
  await sleep(3000);

  for (let attempt = 0; attempt < 15; attempt++) {
    if (Date.now() > deadline) break;

    try {
      const candidate = await page.evaluate((knownSrcArr, knownFpArr, knownBlobArr) => {
        const knownSrcs  = new Set(knownSrcArr);
        const knownFps   = new Set(knownFpArr);
        const knownBlobs = new Set(knownBlobArr);

        const newImgs = [];

        for (const img of document.querySelectorAll("img")) {
          const src = img.src;
          if (!src) continue;

          const isGenerated =
            src.startsWith("blob:") ||
            src.includes("googleusercontent.com") ||
            src.includes("usercontent.google.com");
          if (!isGenerated) continue;

          if (knownSrcs.has(src)) continue;
          if (knownBlobs.has(src)) continue;

          const w = img.naturalWidth  || img.width  || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w < 100 || h < 100) continue;

          let fp = null;
          try {
            const c = document.createElement("canvas");
            c.width = 4; c.height = 4;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0, 4, 4);
            const d = ctx.getImageData(0, 0, 4, 4).data;
            const hex = (i) => "#" + [d[i], d[i+1], d[i+2]].map(v => v.toString(16).padStart(2,"0")).join("");
            fp = `${w}x${h}:${hex(0)}:${hex(4)}:${hex(8)}`;
          } catch {}

          if (fp && knownFps.has(fp)) continue;

          newImgs.push({ src, w, h, fp, complete: img.complete, natural: img.naturalWidth > 0 });
        }

        if (!newImgs.length) return null;
        return newImgs.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));

      }, [...knownSrcSet], [...knownFpSet], [...knownBlobSet]);

      if (candidate) {
        console.log(`[waitForNewImageAfterPrompt] ✓ New image: ${candidate.src.substring(0, 70)}`);
        console.log(`[waitForNewImageAfterPrompt]   ${candidate.w}x${candidate.h} fp=${candidate.fp}`);

        if (!candidate.complete || !candidate.natural) {
          await page.evaluate(async (src) => {
            const img = [...document.querySelectorAll("img")].find(i => i.src === src);
            if (!img || (img.complete && img.naturalWidth > 0)) return;
            await new Promise(res => {
              img.onload  = res;
              img.onerror = res;
              setTimeout(res, 8000);
            });
          }, candidate.src).catch(() => {});
        }

        await sleep(300);
        console.log("[waitForNewImageAfterPrompt] Extracting base64…");
        return await extractImageAsBase64(page, candidate.src);
      }

    } catch (e) {
      console.log(`[waitForNewImageAfterPrompt] Scan error: ${e.message}`);
    }

    console.log(`[waitForNewImageAfterPrompt] Attempt ${attempt + 1}/15 — no new image yet, retrying…`);
    await sleep(1000);
  }

  throw new Error(`No genuinely new image found within ${timeoutMs / 1000}s`);
};

// ─────────────────────────────────────────────
//  IMAGE DETECTION  v8.0
// ─────────────────────────────────────────────

const isGeneratedImageUrl = (url, contentType = "") => {
  if (!url) return false;
  if (contentType && !contentType.startsWith("image/")) return false;
  if (url.includes("gstatic.com")) return false;
  if (/gemini_sparkle|spinner|loading|icon|logo/i.test(url)) return false;
  if (url.includes("/gg-dl/") && !contentType.startsWith("image/")) return false;

  if (contentType.startsWith("image/") &&
      !contentType.includes("svg") &&
      !contentType.includes("x-icon")) {
    if (url.includes("googleusercontent.com") ||
        url.includes("usercontent.google.com") ||
        url.startsWith("blob:") ||
        url.startsWith("data:image")) {
      return true;
    }
  }

  if (url.startsWith("blob:") || url.startsWith("data:image")) return true;

  if (url.includes("googleusercontent.com") || url.includes("usercontent.google.com")) {
    if (url.endsWith(".js") || url.endsWith(".css") || url.endsWith(".woff") ||
        url.endsWith(".svg") || url.endsWith(".ico")) return false;
    if (url.includes("/gg-dl/")) return false;
    if (contentType.startsWith("image/")) return true;
    return false;
  }

  return false;
};

const waitForNewImage = async (page, knownSrcs, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  const knownSet = new Set(knownSrcs);

  console.log(`[waitForNewImage] Starting — known=${knownSrcs.length}, timeout=${timeoutMs / 1000}s`);

  let networkImageUrl = null;
  let networkResolve  = null;
  const networkImagePromise = new Promise(resolve => { networkResolve = resolve; });

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (knownSet.has(url)) return;
      const status = response.status();
      if (status < 200 || status >= 300) return;
      const headers     = response.headers();
      const contentType = headers["content-type"] || "";
      if (isGeneratedImageUrl(url, contentType)) {
        console.log(`[L1-network] Hit: ${url.substring(0, 80)}  type=${contentType}`);
        networkImageUrl = url;
        networkResolve(url);
      }
    } catch {}
  };

  page.on("response", onResponse);

  await page.evaluate(() => {
    window.__newImgSrc = null;
    if (window.__mutObs) { window.__mutObs.disconnect(); }
    window.__mutObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node) continue;
          const imgs = node.tagName === "IMG"
            ? [node]
            : (node.querySelectorAll ? [...node.querySelectorAll("img")] : []);
          for (const img of imgs) {
            const src = img.src || img.dataset?.src || "";
            if (src && (
              src.includes("googleusercontent") ||
              src.includes("usercontent.google") ||
              src.startsWith("blob:") ||
              src.startsWith("data:image")
            )) {
              window.__newImgSrc = src;
            }
          }
        }
        if (m.type === "attributes" && m.target.tagName === "IMG") {
          const src = m.target.src || "";
          if (src && (
            src.includes("googleusercontent") ||
            src.includes("usercontent.google") ||
            src.startsWith("blob:")
          )) {
            window.__newImgSrc = src;
          }
        }
      }
    });
    window.__mutObs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"]
    });
  }).catch(e => console.log("[L3-observer] Inject failed:", e.message));

  const MIN_DIM = 100;
  let domCandidate = null;

  const pollLoop = async () => {
    while (Date.now() < deadline) {
      await sleep(500);
      if (page.isClosed()) break;

      try {
        const result = await page.evaluate((known, minDim) => {
          const mutSrc = window.__newImgSrc;
          if (mutSrc && !known.includes(mutSrc)) {
            return { src: mutSrc, via: "mutation" };
          }
          for (const img of document.querySelectorAll("img")) {
            const src = img.src;
            if (!src || known.includes(src)) continue;
            if (src.includes("googleusercontent") ||
                src.includes("usercontent.google") ||
                src.startsWith("blob:") ||
                src.startsWith("data:image")) {
              const rect = img.getBoundingClientRect();
              const w = rect.width  || img.naturalWidth  || img.width;
              const h = rect.height || img.naturalHeight || img.height;
              if (w >= minDim && h >= minDim) {
                return { src, via: "dom", w, h };
              }
              return { src, via: "dom-small", w, h };
            }
          }
          return null;
        }, [...knownSet], MIN_DIM);

        if (result) {
          console.log(`[L2-dom] Found via ${result.via}: ${result.src.substring(0, 70)}`);
          domCandidate = result.src;
          break;
        }
      } catch {}
    }
  };

  const timeoutPromise = sleep(timeoutMs).then(() => {
    throw new Error(`No image in ${timeoutMs / 1000}s`);
  });

  const winnerUrl = await Promise.race([
    networkImagePromise,
    pollLoop().then(() => domCandidate),
    timeoutPromise
  ]).finally(() => {
    try { page.off("response", onResponse); } catch {}
  });

  if (!winnerUrl) throw new Error("Image detection returned null");
  console.log(`[waitForNewImage] Winner: ${winnerUrl.substring(0, 80)}`);

  if (!winnerUrl.startsWith("data:")) {
    await sleep(600);
    await page.evaluate(async (src) => {
      const img = [...document.querySelectorAll("img")].find(i => i.src === src);
      if (!img || img.complete) return;
      await new Promise(res => {
        img.onload  = res;
        img.onerror = res;
        setTimeout(res, 5000);
      });
    }, winnerUrl).catch(() => {});
  }

  console.log("[waitForNewImage] Extracting base64…");
  return extractImageAsBase64(page, winnerUrl);
};

const waitForNewImageInEdit = waitForNewImage;

// ─────────────────────────────────────────────
//  SAVE IMAGE TO DISK
// ─────────────────────────────────────────────
const saveImage = (dataUrl, label) => {
  const safe = label.replace(/[^a-zA-Z0-9]/g, "_");
  const file = path.join(OUTPUT_DIR, `${safe}_${Date.now()}.png`);
  fs.writeFileSync(file,
    Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
  return file;
};

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
    const { data } = await sharp(imgPath).raw().toBuffer({ resolveWithObject: true });
    let total = 0, n = 0;
    for (let i = 0; i < data.length; i += 40) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    return (total / n) < 128 ? "dark" : "light";
  } catch { return "light"; }
};

const overlayLogo = async (imgPath, logoPath, outPath, opts = {}) => {
  const { position = "top-right", logoScale = 0.22, maxLogoW = 360, padding = 0 } = opts;
  const { width, height } = await sharp(imgPath).metadata();
  const lw  = Math.min(Math.round(width * logoScale), maxLogoW);
  const buf = await sharp(logoPath).resize(lw, null, { withoutEnlargement: true }).toBuffer();
  const px  = Math.round(width * padding);
  let left, top;
  switch (position) {
    case "top-right":    left = width - lw;                   top = 0;                        break;
    case "bottom-left":  left = px;                           top = height - lw * 0.5 - px;   break;
    case "bottom-right": left = width - lw - px;              top = height - lw * 0.5 - px;   break;
    case "center":       left = Math.round((width - lw) / 2); top = Math.round((height - lw * 0.5) / 2); break;
    default:             left = px; top = px;
  }
  await sharp(imgPath)
    .composite([{ input: buf, left: Math.round(left), top: Math.round(top) }])
    .toFile(outPath);
  return outPath;
};

const pickLogo = (brightness, logos, preferred) => {
  if (preferred && logos[preferred]) return logos[preferred];
  return brightness === "dark"
    ? (logos.white || logos.blue  || logos.black)
    : (logos.blue  || logos.black || logos.white);
};

// ─────────────────────────────────────────────
//  DOWNLOAD HELPER
// ─────────────────────────────────────────────
const downloadImage = (src, destPath) => new Promise((resolve, reject) => {
  if (src.startsWith("data:")) {
    fs.writeFileSync(destPath,
      Buffer.from(src.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    return resolve();
  }
  const mod = src.startsWith("https") ? require("https") : require("http");
  const f   = fs.createWriteStream(destPath);
  mod.get(src, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
    res.pipe(f);
    f.on("finish", () => { f.close(); resolve(); });
  }).on("error", reject);
});

// ─────────────────────────────────────────────
//  SEND IMAGE FILE TO CLIENT
// ─────────────────────────────────────────────
const sendImageFile = (res, filePath, extraHeaders = {}) => {
  const stats = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type"        : "image/png",
    "Content-Disposition" : `attachment; filename="${path.basename(filePath)}"`,
    "Content-Length"      : stats.size,
    ...extraHeaders
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("close", () => fs.unlink(filePath, () => {}));
};

// ─────────────────────────────────────────────
//  UPLOAD IMAGE TO GEMINI
// ─────────────────────────────────────────────
async function uploadImageToGemini(page, filePath) {
  console.log("[upload] Starting upload flow...");

  const inputSelector = 'div[contenteditable="true"]';
  await page.waitForSelector(inputSelector, { visible: true });
  await page.click(inputSelector);
  await sleep(1000);

  try {
    console.log("[upload] Method 1: Using + menu...");
    const plusBtn = await page.evaluateHandle(() => {
      const input = document.querySelector('div[contenteditable="true"]');
      if (!input) return null;
      const container = input.closest("div");
      if (!container) return null;
      const buttons = container.querySelectorAll("button");
      return Array.from(buttons).find(btn => {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        return label.includes("attach") || label.includes("upload") || btn.querySelector("svg");
      }) || null;
    });

    if (!plusBtn) throw new Error("Plus button not found");
    await plusBtn.asElement().click();
    await sleep(1000);

    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("span, div"));
      const upload = items.find(el =>
        el.innerText && el.innerText.toLowerCase().includes("upload")
      );
      if (upload) upload.click();
    });

    const fileChooser = await page.waitForFileChooser({ timeout: 5000 });
    await fileChooser.accept([filePath]);
    console.log("[upload] Method 1 success ✓");
    await page.waitForSelector("img", { timeout: 10000 });
    return;
  } catch (e) {
    console.log("[upload] Method 1 failed:", e.message);
  }

  try {
    console.log("[upload] Method 2: Clipboard paste...");
    const image = fs.readFileSync(filePath);
    await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const array  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      const blob = new Blob([array], { type: "image/png" });
      const item = new ClipboardItem({ "image/png": blob });
      await navigator.clipboard.write([item]);
    }, image.toString("base64"));

    await page.keyboard.down("Control");
    await page.keyboard.press("V");
    await page.keyboard.up("Control");
    await page.waitForSelector("img", { timeout: 8000 });
    console.log("[upload] Method 2 success ✓");
    return;
  } catch (e) {
    console.log("[upload] Method 2 failed:", e.message);
  }

  try {
    console.log("[upload] Method 3: Drag & drop...");
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString("base64");
    const name   = path.basename(filePath);
    await page.evaluate(({ base64, name }) => {
      const binary = atob(base64);
      const array  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      const file = new File([array], name, { type: "image/png" });
      const dt   = new DataTransfer();
      dt.items.add(file);
      const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true });
      document.querySelector('div[contenteditable="true"]').dispatchEvent(drop);
    }, { base64, name });
    await page.waitForSelector("img", { timeout: 8000 });
    console.log("[upload] Method 3 success ✓");
    return;
  } catch (e) {
    console.log("[upload] Method 3 failed:", e.message);
  }

  throw new Error("All upload methods failed");
}

// ─────────────────────────────────────────────
//  POLL TEXT RESPONSE
// ─────────────────────────────────────────────
const pollTextResponse = async (page, snapshotBlockCount = 0, config = null) => {
  const MAX_POLLS   = config?.maxPolls   || 60;
  const POLL_MS     = config?.pollMs     || 1500;
  const STABLE_EXIT = config?.stableExit || 6;
  const EXTRA_WAIT  = config?.extraWaitMs || 30000;
  const MIN_LEN     = 80;
  const STRONG_LEN  = 600;

  const SELECTORS = [
    "model-response",
    "message-content",
    ".model-response-text",
    "[data-response-index]",
    "[class*='response-text']",
    "[class*='model-response']",
    "response-element",
  ];

  let best        = null;
  let stableCount = 0;
  let lastLen     = 0;
  let lastStableLen = 0;
  let extraWaitDone = false;

  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(POLL_MS);
    if (page.isClosed()) throw new Error("Page closed during polling");

    const result = await page.evaluate((selectors, beforeCount) => {
      let el = null;
      for (const s of selectors) {
        const all = document.querySelectorAll(s);
        const newBlocks = Array.from(all).slice(beforeCount);
        if (newBlocks.length) { el = newBlocks[newBlocks.length - 1]; break; }
      }

      if (!el) {
        el = [...document.querySelectorAll("div,p,section")]
          .filter(e =>
            e.innerText?.length > 100 &&
            !e.closest("[contenteditable]") &&
            !e.closest("form") &&
            !e.closest("input")
          )
          .sort((a, b) => b.innerText.length - a.innerText.length)[0] || null;
      }

      const text = el?.innerText?.trim() || null;
      const isLoading = !!(
        document.querySelector("loading-indicator") ||
        document.querySelector("[class*='loading-indicator']") ||
        document.querySelector("[class*='generating']") ||
        document.querySelector("[class*='thinking']") ||
        document.querySelector("[data-is-streaming='true']") ||
        document.querySelector("pendulum-spinner") ||
        document.querySelector("[class*='progress-bar']") ||
        document.querySelector("button[aria-label*='Stop' i]") ||
        document.querySelector("button[aria-label*='Cancel' i]")
      );

      return { text, loading: isLoading, len: text?.length || 0 };
    }, SELECTORS, snapshotBlockCount).catch(() => ({ text: null, loading: false, len: 0 }));

    const { text, loading, len } = result;

    if (text && len > (best?.length || 0)) best = text;

    if (len === lastLen && len >= MIN_LEN) {
      if (stableCount === 0) lastStableLen = len;
      stableCount++;
    } else {
      stableCount = 0;
      lastStableLen = 0;
      extraWaitDone = false;
    }
    lastLen = len;

    console.log(`[Verify] poll ${i}/${MAX_POLLS} loading=${loading} len=${len} stable=${stableCount}`);

    if (stableCount === 4 && lastStableLen === len && len >= MIN_LEN && !extraWaitDone) {
      console.log(`[Verify] Stable at count=4 with same length (${len}) — waiting ${EXTRA_WAIT/1000}s extra…`);
      await sleep(EXTRA_WAIT);
      extraWaitDone = true;
      continue;
    }

    if (!loading && stableCount >= STABLE_EXIT && len >= MIN_LEN) {
      console.log(`[Verify] Clean exit at poll ${i}`);
      return text;
    }

    if (stableCount >= STABLE_EXIT && len >= STRONG_LEN) {
      console.log(`[Verify] Strong stable exit at poll ${i} (loading ignored)`);
      return text;
    }

    if (!loading && stableCount >= 3 && len >= MIN_LEN && i >= 5) {
      console.log(`[Verify] Loading done exit at poll ${i}`);
      return text;
    }
  }

  if (best && best.length >= MIN_LEN) {
    console.log(`[Verify] Exhausted polls, returning best (len=${best.length})`);
    return best;
  }

  return page.evaluate(() => document.body.innerText.trim()).catch(() => null);
};

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
//  POST /generate_prompt
// ─────────────────────────────────────────────
app.post("/generate_prompt", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  await acquireChrome();
  console.log("\n=== /generate_prompt ===");

  try {
    const { prompt } = req.body;
    if (!prompt)
      return res.status(400).json({ success: false, error: "prompt required" });

    await ensureChrome();
    const page = await getPage(GEMINI_BASE);

    if (page.url() !== GEMINI_BASE)
      await page.goto(GEMINI_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

    await waitForInput(page, 35000);
    await sleep(600);

    if (page.url().includes("signin"))
      throw new Error("Gemini sign-in required — log in first");

    const previousUrl = page.url();

    await pastePrompt(page, prompt);
    await page.keyboard.press("Enter");
    console.log("[generate_prompt] Enter key pressed ✓");

    console.log("[generate_prompt] Prompt sent — waiting for chat URL…");
    const chatUrl = await waitForChatUrl(page, previousUrl, 60000);

    if (!chatUrl || chatUrl === GEMINI_BASE)
      throw new Error("Chat URL did not change after sending prompt");

    console.log(`[generate_prompt] Chat URL: ${chatUrl}`);

    // CRITICAL: Keep browser alive so chat URL stays valid
    // Do NOT close page or disconnect browser
    console.log("[generate_prompt] Keeping browser alive for /generate reuse…");

    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(sessionId, { 
      chatUrl, 
      createdAt: Date.now(), 
      originalPrompt: prompt,
      pageKeptOpen: true 
    });
    saveSessions();
    console.log(`[generate_prompt] Done → session ${sessionId}`);
    
    // Release mutex but KEEP browser connected
    releaseChrome();
    
    return res.json({ success: true, session_id: sessionId, chat_url: chatUrl });

  } catch (err) {
    console.error("[generate_prompt] ERROR:", err.message);
    if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
    if (!res.headersSent)
      return res.status(500).json({ success: false, error: err.message });
    releaseChrome();
  }
});
// ─────────────────────────────────────────────
//  POST /generate
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
//  POST /generate  (with debug screenshots)
// ─────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  await acquireChrome();
  console.log("\n=== /generate ===");

  try {
    const { session_id, second_prompt, company_name } = req.body;
    if (!session_id)    return res.status(400).json({ success: false, error: "session_id required" });
    if (!second_prompt) return res.status(400).json({ success: false, error: "second_prompt required" });

    const session = sessions.get(session_id);
    if (!session) return res.status(404).json({ success: false, error: "Session not found or expired" });

    let { chatUrl } = session;
    const safeName = (company_name || "Poster").replace(/[^a-zA-Z0-9]/g, "_");

    await ensureChrome();
    
    const b = await connectBrowser();
    const pages = await b.pages();
    
    let page = pages.find(p => p.url().includes(chatUrl.split('/').pop()) || p.url() === chatUrl);
    
    if (!page || page.isClosed()) {
      console.log(`[generate] Existing page not found, navigating fresh…`);
      page = await getPage(chatUrl);
      await page.goto(chatUrl, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 60000 });
      await waitForInput(page, 30000);
    } else {
      console.log(`[generate] Reusing existing page: ${page.url()}`);
      await page.bringToFront();
      await sleep(1000);
    }

    let currentUrl = page.url();
    console.log(`[generate] On page: ${currentUrl}`);

    // 🔴 DEBUG: Screenshot current state
    await takeScreenshot(page, "01_before_prompt");

    // If chat expired, recreate
    if (currentUrl === GEMINI_BASE || currentUrl.endsWith('/app')) {
      console.log(`[generate] Chat expired. Re-creating with original prompt…`);
      const previousUrl = page.url();
      await pastePrompt(page, session.originalPrompt || second_prompt);
      await page.keyboard.press("Enter");
      
      const newChatUrl = await waitForChatUrl(page, previousUrl, 60000);
      if (newChatUrl && newChatUrl !== GEMINI_BASE) {
        chatUrl = newChatUrl;
        sessions.set(session_id, { chatUrl: newChatUrl, createdAt: Date.now(), originalPrompt: session.originalPrompt });
        saveSessions();
      } else {
        throw new Error('Failed to recreate chat session');
      }
      await sleep(1500);
      currentUrl = page.url();
    }

    console.log(`[generate] Ready on: ${currentUrl}`);
    
    // 🔴 DEBUG: Screenshot before sending second prompt
    await takeScreenshot(page, "02_ready_for_second_prompt");

    const knownSrcs = await snapshotAllImgSrcs(page);
    console.log(`[generate] Known images: ${knownSrcs.length}`);

    const attemptTimeouts = [120000, 180000, 240000];
    let dataUrl = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= attemptTimeouts.length; attempt++) {
      const imageWaitMs = attemptTimeouts[attempt - 1];
      console.log(`[generate] === Attempt ${attempt}/${attemptTimeouts.length} — image wait: ${imageWaitMs / 1000}s ===`);

      try {
        const imagePromise = waitForNewImage(page, knownSrcs, imageWaitMs);
        await sleep(200);

        await pastePrompt(page, second_prompt);
        await page.keyboard.press("Enter");
        console.log("[generate] Enter key pressed ✓");

        // 🔴 DEBUG: Screenshot right after submitting
        await takeScreenshot(page, `03_attempt${attempt}_after_submit`);

        console.log(`[generate] Waiting for generated image…`);
        dataUrl = await imagePromise;
        console.log(`[generate] Image received on attempt ${attempt}`);
        
        // 🔴 DEBUG: Screenshot with image
        await takeScreenshot(page, `04_attempt${attempt}_image_found`);
        break;

      } catch (e) {
        lastErr = e;
        console.error(`[generate] Attempt ${attempt} failed: ${e.message}`);
        
        // 🔴 DEBUG: Screenshot on failure
        await takeScreenshot(page, `05_attempt${attempt}_failed`);

        if (attempt < attemptTimeouts.length) {
          console.log(`[generate] Retrying in 3s…`);
          await sleep(3000);
          try {
            const freshSrcs = await snapshotAllImgSrcs(page);
            console.log(`[generate] Refreshed known images: ${freshSrcs.length}`);
          } catch (refreshErr) {
            console.log(`[generate] Could not refresh knownSrcs: ${refreshErr.message}`);
          }
        }
      }
    }

    if (!dataUrl) {
      throw new Error(`All attempts failed. Last: ${lastErr?.message}`);
    }

    const imgPath    = saveImage(dataUrl, safeName);
    const brightness = await imageBrightness(imgPath);
    const finalUrl   = page.url();

    sessions.delete(session_id);
    saveSessions();
    
    if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
    
    sendImageFile(res, imgPath, { "X-Image-Brightness": brightness, "X-Chat-Url": finalUrl });
    console.log("[generate] Done ✓");

  } catch (err) {
    console.error("[generate] ERROR:", err.message);
    if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
    if (!res.headersSent)
      res.status(500).json({ success: false, error: err.message });
  } finally {
    releaseChrome();
  }
});
// ─────────────────────────────────────────────
//  POST /edit
// ─────────────────────────────────────────────
app.post("/edit", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  await acquireChrome();
  console.log("\n=== /edit ===");

  try {
    const { chat_url, correction_prompt, company_name } = req.body;
    if (!chat_url)          return res.status(400).json({ success: false, error: "chat_url required" });
    if (!correction_prompt) return res.status(400).json({ success: false, error: "correction_prompt required" });

    const safeName = (company_name || "EditPoster").replace(/[^a-zA-Z0-9]/g, "_");

    const MAX_ATTEMPTS = 3;
    const attemptTimeouts = [120000, 180000, 240000];
    let dataUrl = null;
    let lastErr = null;
    let page = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`\n[edit] === Attempt ${attempt}/${MAX_ATTEMPTS} ===`);
      const imageWaitMs = attemptTimeouts[attempt - 1] || CFG.IMAGE_WAIT_MS;

      try {
        if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
        await nukeChrome();
        await ensureChrome();

        page = await getPage(chat_url);
        await page.goto(chat_url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 60000 });

        if (page.url().includes("signin")) throw new Error("Gemini sign-in required");

        await waitForInput(page, 30000);

        console.log("[edit] Waiting for DOM to stabilise…");
        let lastCount = -1, stableRounds = 0;
        for (let i = 0; i < 20; i++) {
          await sleep(800);
          const count = await page.evaluate(() =>
            [...document.querySelectorAll("img")]
              .filter(img => img.src && (
                img.src.includes("googleusercontent") ||
                img.src.includes("usercontent.google") ||
                img.src.startsWith("blob:")
              )).length
          );
          if (count === lastCount) {
            stableRounds++;
            if (stableRounds >= 2) {
              console.log(`[edit] DOM stable at ${count} images`);
              break;
            }
          } else {
            stableRounds = 0;
            lastCount = count;
          }
        }

        const knownSrcs = await snapshotAllImgSrcs(page);
        console.log(`[edit] Known images after settle: ${knownSrcs.length}`);
        await sleep(300);

        const promptSentAt = Date.now();
        await pastePrompt(page, correction_prompt);
        await page.keyboard.press("Enter");
        console.log("[edit] Enter key pressed ✓");

        console.log(`[edit] Waiting for new image (up to ${imageWaitMs / 1000}s)…`);
        dataUrl = await waitForNewImageAfterPrompt(page, knownSrcs, promptSentAt, imageWaitMs);
        console.log(`[edit] Image received on attempt ${attempt}`);
        break;

      } catch (e) {
        lastErr = e;
        console.error(`[edit] Attempt ${attempt} failed: ${e.message}`);
        if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
        await nukeChrome();
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[edit] Retrying in 3s with longer timeout…`);
          await sleep(3000);
        }
      }
    }

    if (!dataUrl) {
      throw new Error(`All ${MAX_ATTEMPTS} attempts failed. Last: ${lastErr?.message}`);
    }

    const imgPath    = saveImage(dataUrl, safeName);
    const brightness = await imageBrightness(imgPath);

    await nukeChrome();
    sendImageFile(res, imgPath, { "X-Image-Brightness": brightness, "X-Chat-Url": page.url() });
    console.log("[edit] Done ✓");

  } catch (err) {
    console.error("[edit] ERROR:", err.message);
    await nukeChrome();
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  } finally {
    releaseChrome();
  }
});

// ─────────────────────────────────────────────
//  POST /addlogo
// ─────────────────────────────────────────────
app.post("/addlogo", async (req, res) => {
  req.setTimeout(60000);
  try {
    const { image_url, image_base64, preferred_logo,
            position = "top-right", logo_scale = 0.22 } = req.body;

    if (!image_url && !image_base64)
      return res.status(400).json({ success: false, error: "image_url or image_base64 required" });

    const ts      = Date.now();
    const inPath  = path.join(OUTPUT_DIR, `in_${ts}.png`);
    const outPath = path.join(OUTPUT_DIR, `logo_${ts}.png`);

    await downloadImage(image_url || image_base64, inPath);

    const logos      = getLogoPaths();
    const brightness = await imageBrightness(inPath);
    const logoPath   = pickLogo(brightness, logos, preferred_logo);
    if (!logoPath) throw new Error("No logo file found — check logos/ folder");

    await overlayLogo(inPath, logoPath, outPath, { position, logoScale: logo_scale });
    fs.unlinkSync(inPath);

    sendImageFile(res, outPath, { "X-Image-Brightness": brightness });
    console.log("[addlogo] Done ✓");

  } catch (err) {
    console.error("[addlogo] ERROR:", err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});
// ─────────────────────────────────────────────
//  GET /debug_screenshots — List all screenshots
// ─────────────────────────────────────────────
app.get("/debug_screenshots", (req, res) => {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      return res.json({ success: true, screenshots: [], count: 0 });
    }
    
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.startsWith("debug_"))
      .map(f => ({
        filename: f,
        url: `${req.protocol}://${req.get("host")}/debug_screenshots/${f}`,
        size: fs.statSync(path.join(OUTPUT_DIR, f)).size,
        created: fs.statSync(path.join(OUTPUT_DIR, f)).mtime
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created)); // newest first

    res.json({ success: true, screenshots: files, count: files.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /debug_screenshots/:filename — Download a screenshot
// ─────────────────────────────────────────────
app.get("/debug_screenshots/:filename", (req, res) => {
  try {
    const filePath = path.join(OUTPUT_DIR, req.params.filename);
    
    // Security: ensure file is inside OUTPUT_DIR
    if (!filePath.startsWith(OUTPUT_DIR)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    res.sendFile(filePath, { 
      headers: { "Content-Type": "image/png" },
      dotfiles: "deny" 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ─────────────────────────────────────────────
//  POST /verify_poster
// ─────────────────────────────────────────────
app.post("/verify_poster", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  await acquireChrome();
  console.log("\n=== /verify_poster ===");

  let tempPath = null;

  try {
    const { verify_prompt, image_url } = req.body;
    if (!verify_prompt) return res.status(400).json({ success: false, error: "verify_prompt required" });
    if (!image_url)     return res.status(400).json({ success: false, error: "image_url required" });

    tempPath = path.join(OUTPUT_DIR, `verify_${Date.now()}.png`);
    await downloadImage(image_url, tempPath);
    const sz = fs.statSync(tempPath).size;
    if (sz < 100) throw new Error(`Image too small (${sz} bytes) — download failed`);
    console.log(`[verify_poster] Image on disk: ${sz} bytes`);

    const MAX_ATTEMPTS = 3;
    let lastErr = null;

    const attemptConfigs = [
      { maxPolls: 60,  pollMs: 1500, stableExit: 6,  extraWaitMs: 30000 },
      { maxPolls: 90,  pollMs: 2000, stableExit: 8,  extraWaitMs: 45000 },
      { maxPolls: 120, pollMs: 2500, stableExit: 10, extraWaitMs: 60000 },
    ];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`\n[verify_poster] === Attempt ${attempt}/${MAX_ATTEMPTS} ===`);

      try {
        if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
        await nukeChrome();
        await ensureChrome();

        const b     = await connectBrowser();
        const pages = await b.pages();
        const page  = pages[0] || await b.newPage();

        await page.goto(GEMINI_BASE, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 35000 });
        await sleep(2000);

        await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const startBtn = buttons.find(b => 
            (b.innerText || '').includes('Write anything') ||
            (b.innerText || '').includes('Help me learn') ||
            (b.innerText || '').includes('Create image') ||
            (b.innerText || '').includes('Get started')
          );
          if (startBtn) { startBtn.click(); return true; }
          const overlay = document.querySelector('[data-test-id="onboarding-dialog"], .modal, [role="dialog"]');
          if (overlay) {
            const closeBtn = overlay.querySelector('button, [aria-label*="close" i]');
            if (closeBtn) closeBtn.click();
          }
          return false;
        }).then(dismissed => {
          if (dismissed) console.log('[verify_poster] Dismissed onboarding screen');
        }).catch(() => {});

        await sleep(1500);
        await waitForInput(page, 30000);

        if (page.url().includes("signin"))
          throw new Error("Gemini sign-in required");

        const blockCountBefore = await page.evaluate(() =>
          document.querySelectorAll(
            "model-response, message-content, [data-response-index], [class*='model-response']"
          ).length
        );
        console.log(`[verify_poster] Blocks before send: ${blockCountBefore}`);

        await uploadImageToGemini(page, tempPath);

        console.log("[verify_poster] Waiting for image to attach...");
        await page.waitForFunction(
          () => document.querySelector("img") !== null,
          { timeout: 15000 }
        );
        await sleep(1500);

        await pastePrompt(page, verify_prompt);
        await sleep(800);

        const promptPasted = await page.evaluate(() => {
          const el = document.querySelector('div[contenteditable="true"]');
          return el && (el.innerText || el.textContent).trim().length > 50;
        });

        if (!promptPasted) {
          console.log('[verify_poster] Prompt not detected in input, retrying paste…');
          await pastePrompt(page, verify_prompt);
          await sleep(800);
        }

        let sent = false;
        for (let sendAttempt = 0; sendAttempt < 3; sendAttempt++) {
          console.log(`[verify_poster] Submit attempt ${sendAttempt + 1}/3…`);

          if (sendAttempt === 0) {
            try {
              const sendBtn = await page.evaluateHandle(() => {
                const buttons = [...document.querySelectorAll('button')];
                return buttons.find(b => {
                  const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                  return aria.includes('send') || aria.includes('submit');
                }) || buttons[buttons.length - 1];
              });
              if (sendBtn) {
                await sendBtn.asElement().click();
                console.log('[verify_poster] Clicked send button');
              }
            } catch (e) {
              console.log('[verify_poster] Send button click failed:', e.message);
            }
          } else if (sendAttempt === 1) {
            try {
              await page.evaluate(() => {
                const el = document.querySelector('div[contenteditable="true"]');
                if (!el) return;
                const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
                const kp = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
                el.dispatchEvent(kd);
                el.dispatchEvent(kp);
              });
              console.log('[verify_poster] Dispatched custom Enter events');
            } catch (e) {
              console.log('[verify_poster] Custom Enter dispatch failed:', e.message);
            }
          } else {
            await page.keyboard.press("Enter");
          }

          await sleep(1200);

          const blockCountAfterSend = await page.evaluate(() =>
            document.querySelectorAll(
              "model-response, message-content, [data-response-index], [class*='model-response']"
            ).length
          );
          console.log(`[verify_poster] Blocks after send attempt: ${blockCountAfterSend}`);

          if (blockCountAfterSend > blockCountBefore) {
            sent = true;
            console.log('[verify_poster] Response block detected — prompt sent successfully');
            break;
          }

          if (!sent && sendAttempt < 2) {
            await sleep(800);
          }
        }

        if (!sent) {
          console.log('[verify_poster] Could not confirm prompt was sent, but continuing…');
        }

        console.log("[verify_poster] Prompt sent — polling…");

        const cfg = attemptConfigs[attempt - 1];
        const analysis = await pollTextResponse(page, blockCountBefore, cfg);

        if (!analysis || analysis.length < 30)
          throw new Error("Gemini returned empty or too-short response");

        const hasGeminiSaid = analysis.toLowerCase().includes("gemini said");

        if (!hasGeminiSaid) {
          console.log(`[verify_poster] "Gemini said" NOT found (len=${analysis.length}). Retrying…`);
          if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
          await nukeChrome();
          if (attempt < MAX_ATTEMPTS) { await sleep(3000); continue; }
          try { fs.unlinkSync(tempPath); tempPath = null; } catch {}
          return res.json({
            success  : true,
            analysis,
            chat_url : page.url(),
            warning  : "Response may be incomplete — 'Gemini said' not detected"
          });
        }

        console.log(`[verify_poster] "Gemini said" confirmed (len=${analysis.length})`);
        const chatUrl = page.url();

        try { fs.unlinkSync(tempPath); tempPath = null; } catch {}
        await nukeChrome();
        console.log("[verify_poster] Done ✓");

        return res.json({ success: true, analysis, chat_url: chatUrl });

      } catch (e) {
        lastErr = e;
        console.error(`[verify_poster] Attempt ${attempt} failed: ${e.message}`);
        if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
        await nukeChrome();
        if (attempt < MAX_ATTEMPTS) await sleep(3000);
      }
    }

    throw new Error(`All ${MAX_ATTEMPTS} attempts failed. Last: ${lastErr?.message}`);

  } catch (err) {
    console.error("[verify_poster] ERROR:", err.message);
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    if (browser)  { try { await browser.disconnect(); } catch {} browser = null; }
    if (!res.headersSent)
      res.status(500).json({ success: false, error: err.message });
  } finally {
    releaseChrome();
  }
});

// ─────────────────────────────────────────────
//  GET /status/:session_id
// ─────────────────────────────────────────────
app.get("/status/:session_id", (req, res) => {
  const s = sessions.get(req.params.session_id);
  if (!s) return res.status(404).json({ success: false, error: "Session not found" });
  res.json({
    success         : true,
    chat_url        : s.chatUrl,
    elapsed_seconds : Math.floor((Date.now() - s.createdAt) / 1000)
  });
});

// ─────────────────────────────────────────────
//  POST /shutdown
// ─────────────────────────────────────────────
app.post("/shutdown", async (req, res) => {
  sessions.clear();
  await nukeChrome();
  res.json({ success: true, message: "Shutdown complete" });
});

// ─────────────────────────────────────────────
//  GET /debug_gemini
// ─────────────────────────────────────────────
app.get("/debug_gemini", async (req, res) => {
  await acquireChrome();
  try {
    await ensureChrome();
    const page = await getPage(GEMINI_BASE);
    await sleep(4000);

    const dump = await page.evaluate(() => ({
      pageUrl  : location.href,
      buttons  : [...document.querySelectorAll("button,[role='button'],mat-icon-button")]
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            tag    : el.tagName,
            aria   : el.getAttribute("aria-label"),
            jsname : el.getAttribute("jsname"),
            text   : el.innerText?.trim().slice(0, 40),
            rect   : { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          };
        }),
      inputs   : [...document.querySelectorAll("input")].map(el => ({
        type: el.type, id: el.id, accept: el.accept,
        visible: el.getBoundingClientRect().width > 0
      })),
      bodyText : document.body.innerText.slice(0, 500)
    }));

    if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
    res.json({ success: true, ...dump });

  } catch (err) {
    if (browser) { try { await browser.disconnect(); } catch {} browser = null; }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    releaseChrome();
  }
});

// ─────────────────────────────────────────────
//  GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Express]", err);
  if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
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
//  START SERVER
// ─────────────────────────────────────────────
const server = app.listen(3000, "0.0.0.0", () => {
  console.log("===========================================");
  console.log("  Gemini Poster Bot API  v8.0");
  console.log("  Listening on http://0.0.0.0:3000");
  console.log("===========================================");
});

server.keepAliveTimeout = 620000;
server.headersTimeout   = 620000;
