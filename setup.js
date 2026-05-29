/**
 * setup.js — Run ONCE to log into ChitChat with your Google account.
 * Saves your session to ./chrome-profile/ so the bot reuses it forever.
 *
 * Usage:
 *   On your LOCAL laptop:  node setup.js
 *   On a server with VNC:  DISPLAY=:1 node setup.js
 *
 * After logging in, close the browser → profile is saved.
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const PROFILE_DIR = path.resolve(__dirname, 'chrome-profile');
const SITE_URL    = 'https://app.chitchat.gg';

async function setup() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║       ChitChat Bot — First-Time Setup    ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('✅ A REAL browser will open (not headless).');
    console.log('✅ Log into ChitChat using your Google account.');
    console.log('✅ Complete any CAPTCHA or verification manually.');
    console.log('✅ Once you\'re on the main chat page, close the browser.');
    console.log('');
    console.log('🔑 Your session will be saved to: chrome-profile/');
    console.log('   The bot will reuse this — no login needed again.');
    console.log('');

    if (!fs.existsSync(PROFILE_DIR)) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
        console.log('📁 Created chrome-profile/ folder.');
    }

    const browser = await puppeteer.launch({
        headless: false,           // ← VISIBLE browser for manual login
        userDataDir: PROFILE_DIR,  // ← Saves cookies, localStorage, session
        defaultViewport: null,     // Use full window size
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized',
            // Makes Puppeteer look like real Chrome
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'], // Hide automation flag
    });

    const page = await browser.newPage();

    // Extra stealth — hide webdriver property
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });

    try {
        await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        if (err.message.includes('detached') || err.message.includes('Navigation')) {
            await new Promise(r => setTimeout(r, 3000)); // Let redirect settle, then continue
        } else { throw err; }
    }

    console.log('');
    console.log('🌐 Browser opened at:', SITE_URL);
    console.log('👆 Complete login + any CAPTCHA manually.');
    console.log('📌 When you\'re on the chat page → CLOSE the browser window.');
    console.log('');

    // Wait for browser to be closed by user
    await new Promise(resolve => {
        browser.on('disconnected', resolve);
    });

    console.log('');
    console.log('✅ Browser closed. Session saved to chrome-profile/');
    console.log('');
    console.log('➡️  Now start the bot with: npm start');
    console.log('   Or if on server with PM2:  pm2 start bot.js --name chitchat-bot');
    console.log('');
}

setup().catch(err => {
    console.error('❌ Setup failed:', err.message);
    process.exit(1);
});