import { chromium } from "playwright";
import fs from "fs";
import * as dotenv from 'dotenv';
dotenv.config();

const DUMP_FILE = "scratch/pinnacle-realtime-dump.log";
fs.writeFileSync(DUMP_FILE, "");

function logOutput(prefix: string, data: any) {
  const timestamp = new Date().toISOString();
  let msg = '';
  try {
    msg = typeof data === 'string' ? data : JSON.stringify(data);
  } catch (e) {
    msg = String(data);
  }
  const logLine = `[${timestamp}] [${prefix}] ${msg}\n`;
  fs.appendFileSync(DUMP_FILE, logLine);
}

async function run() {
  console.log("🚀 Starting Autonomous Research Browser...");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 }
  });
  const page = await ctx.newPage();

  console.log("Solving CF & Logging in to Betjili...");
  await page.goto("https://betjili365.com/bd/en", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const loginBody = {
    getIntercomInfo: true,
    languageTypeId: 1,
    currencyTypeId: 8,
    loginTypeId: 0,
    accessToken: "",
    userId: process.env.BETJILI_USERNAME!,
    password: process.env.BETJILI_PASSWORD!,
    isBioLogin: false,
    fingerprint2: "96a5dbddb9f4d2a3fb938f9bf3d1c391",
    fingerprint4: "3cfe78c2633ed6b41ef9e83c6866ff29",
    browserHash: "da570c9355beac82ccd4e6ec22f63c91",
    deviceHash: "ad75c04f51946a8ffc154798f47b71e2",
    fbp: "", fbc: "", ttp: "", ttc: "", ttclid: "",
  };

  const loginRes = await page.evaluate(async (body) => {
    const res = await fetch("https://betjili365.com/api/bt/v2_1/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    return res.json();
  }, loginBody);

  const accessToken = loginRes?.data?.accessToken;
  if (!accessToken) throw new Error("Failed to get betjili token");

  console.log("Getting Pinnacle Game URL...");
  const gameUrlRes = await page.evaluate(async (token) => {
    const res = await fetch("https://betjili365.com/api/bt/v1/provider/getGameUrl", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        languageTypeId: 1, currencyTypeId: 8, gameTypeId: 4, vendorCode: "AWCV2_PINNACLE", isDesktop: 1, gameCode: "PINNACLE-SPORTS-001"
      })
    });
    return res.json();
  }, accessToken);

  const gameUrl = gameUrlRes?.data?.gameUrl;
  if (!gameUrl) throw new Error("Failed to get gameUrl");

  console.log("Navigating to Pinnacle:", gameUrl);
  
  // Attach listeners before navigation
  page.on('websocket', (ws) => {
    logOutput('WS_OPEN', `URL: ${ws.url()}`);
    ws.on('framesent', p => logOutput('WS_SEND', p.payload));
    ws.on('framereceived', p => logOutput('WS_RECV', p.payload));
    ws.on('close', () => logOutput('WS_CLOSE', `URL: ${ws.url()}`));
  });

  page.on('response', async (response) => {
    const req = response.request();
    const rt = req.resourceType();
    if (['xhr', 'fetch', 'eventsource'].includes(rt)) {
      const url = req.url();
      if (url.includes('push') || url.includes('sync') || url.includes('odds') || url.includes('markets')) {
        try {
          const text = await response.text();
          if (text) logOutput(`FETCH_RECV [${response.status()}] ${url}`, text);
        } catch (e) {}
      }
    }
  });

  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  
  // Navigate to an in-play/live football game to see odds change if possible
  // Pinnacle frontend usually defaults to Live or we can wait to see if it receives global pushes.
  // Wait for 30 seconds to capture traffic
  console.log("Waiting 30 seconds to capture real-time traffic...");
  let ticks = 0;
  while(ticks < 30) {
    await page.waitForTimeout(1000);
    ticks++;
    if (ticks % 5 === 0) console.log(`... ${ticks}s elapsed`);
  }

  console.log("Closing browser...");
  await browser.close();
  
  // Summary
  const logContent = fs.readFileSync(DUMP_FILE, 'utf-8');
  const wsOpen = (logContent.match(/WS_OPEN/g) || []).length;
  const wsRecv = (logContent.match(/WS_RECV/g) || []).length;
  const fetches = (logContent.match(/FETCH_RECV/g) || []).length;
  console.log(`\nDump Complete:`);
  console.log(`- WebSockets Opened: ${wsOpen}`);
  console.log(`- WebSocket Messages Received: ${wsRecv}`);
  console.log(`- XHR/Fetch Messages Received: ${fetches}`);
}

run().catch(console.error);
