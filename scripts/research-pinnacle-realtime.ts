import { chromium, type Page, type WebSocket } from 'playwright';
import fs from 'fs';
import path from 'path';

// Load environment variables if necessary
import * as dotenv from 'dotenv';
dotenv.config();

const DUMP_FILE = path.join(process.cwd(), 'scratch', 'pinnacle-realtime-dump.log');

// Clear previous dump
if (fs.existsSync(DUMP_FILE)) {
  fs.writeFileSync(DUMP_FILE, '');
}

function logOutput(prefix: string, data: any) {
  const timestamp = new Date().toISOString();
  let msg = '';
  try {
    msg = typeof data === 'string' ? data : JSON.stringify(data);
  } catch (e) {
    msg = String(data);
  }
  
  const logLine = `[${timestamp}] [${prefix}] ${msg}\n`;
  console.log(`[${prefix}] ${msg.substring(0, 150)}${msg.length > 150 ? '...' : ''}`);
  fs.appendFileSync(DUMP_FILE, logLine);
}

async function run() {
  console.log('🚀 Starting Research Browser...');
  console.log(`📂 Network traffic will be dumped to: ${DUMP_FILE}`);
  
  const browser = await chromium.launch({ 
    headless: false, // We need to see it to navigate
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1. Listen for WebSockets (The most common way real-time odds are delivered)
  page.on('websocket', (ws: WebSocket) => {
    logOutput('WS_OPEN', `WebSocket opened to URL: ${ws.url()}`);

    ws.on('framesent', payload => {
      // payload.payload is either string or Buffer
      logOutput('WS_SEND', payload.payload);
    });

    ws.on('framereceived', payload => {
      logOutput('WS_RECV', payload.payload);
    });

    ws.on('close', () => {
      logOutput('WS_CLOSE', `WebSocket closed: ${ws.url()}`);
    });
  });

  // 2. Listen for XHR/Fetch (In case they use Short Polling or Server-Sent Events)
  page.on('response', async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    
    // We only care about XHR, Fetch, or Eventsource
    if (['xhr', 'fetch', 'eventsource'].includes(resourceType)) {
      const url = request.url();
      
      // Filter out obvious noise like images, css, or tracking if necessary
      // But for now, we'll log anything that looks like an API call.
      if (url.includes('/api/') || url.includes('graphql') || url.includes('odds') || url.includes('markets') || url.includes('push') || url.includes('sync')) {
        try {
          // Attempt to parse JSON response to see if it contains odds
          const text = await response.text();
          if (text && text.length > 0) {
            logOutput(`FETCH_RECV [${response.status()}] ${url}`, text);
          }
        } catch (e) {
          // Ignore errors parsing binary or aborted responses
        }
      }
    }
  });

  console.log('\n======================================================');
  console.log('Instructions:');
  console.log('1. The browser has opened.');
  console.log('2. Navigate to your provider\'s Pinnacle integration (e.g., Betjili or similar).');
  console.log('3. Log in if necessary.');
  console.log('4. Go to a LIVE match and watch for the odds to update on the screen.');
  console.log('5. Let it sit for a minute to capture the updates.');
  console.log('6. Close the browser when you are done.');
  console.log('======================================================\n');

  // Keep script alive until the user closes the browser
  await new Promise(resolve => browser.on('disconnected', resolve));
  console.log('Browser closed. Research session ended.');
}

run().catch(console.error);
