const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1280,900"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  
  console.log("Navigating to Gemini...");
  await page.goto("https://gemini.google.com/app", { waitUntil: "networkidle" });
  
  console.log("1. Log into Gemini manually in this browser");
  console.log("2. Once you see the chat interface, press any key in this terminal to save cookies");
  
  // Wait for keypress
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  
  // Save cookies
  const cookies = await context.cookies();
  const fs = require("fs");
  fs.writeFileSync("gemini-cookies.json", JSON.stringify(cookies, null, 2));
  console.log("Cookies saved to gemini-cookies.json");
  
  await browser.close();
  process.exit(0);
})();