const puppeteer = require("puppeteer");
const path = require("path");

(async () => {
  const userDataDir = path.join(__dirname, "chrome-profile");
  
  const browser = await puppeteer.launch({
    headless: false, // MUST be visible for manual login
    userDataDir: userDataDir,
    executablePath: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--window-size=1280,900"]
  });

  const page = await browser.newPage();
  await page.goto("https://gemini.google.com/app");
  
  console.log("1. Log into Gemini manually in the opened Chrome window");
  console.log("2. Make sure you see the Gemini chat interface");
  console.log("3. Press Ctrl+C here to save the profile");
  
  // Keep alive until manually stopped
  await new Promise(() => {});
})();