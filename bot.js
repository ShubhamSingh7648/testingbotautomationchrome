/**
 * bot.js — ChitChat automation + Telegram relay
 * Requires: npm run setup first (to save Chrome login session)
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const TelegramBot = require('node-telegram-bot-api');
const SEL = require('./selectors');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;
const MY_NAME  = process.env.MY_NAME || "self-confident teste";
const SITE_URL = 'https://app.chitchat.gg';
const PROFILE_DIR = path.resolve(__dirname, 'chrome-profile');

const LOOP_MS            = 700;
const SKIP_DELAY_MS      = 500;
const CONNECT_TIMEOUT_MS = 9000;
const REPLY_TIMEOUT_MS   = 13000;
const RELAY_IDLE_MS      = 3 * 60 * 1000;

// ─── State ────────────────────────────────────────────────────────────────────
let browser, page;
let state = "paused";
let processedMsgs = new Set();
let genderAnswered = false;
let connTimer = null;
let relayIdleTimer = null;
let isSkipping = false;
let automationEnabled = false;
let loopRunning = false;
let stats = { skipped: 0, sessionStart: null };
let selectorErrors = 0; // Track consecutive selector failures

// ─── Validate env ─────────────────────────────────────────────────────────────
if (!TOKEN || !ADMIN_ID) {
    console.error("❌ Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID in .env");
    process.exit(1);
}

if (!fs.existsSync(PROFILE_DIR)) {
    console.error("❌ chrome-profile/ not found. Run 'npm run setup' first!");
    process.exit(1);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

function notify(text, opts = {}) {
    return bot.sendMessage(ADMIN_ID, text, opts)
        .catch(err => console.error('[TG Error]', err.message));
}

// ─── Browser ──────────────────────────────────────────────────────────────────
async function launchBrowser() {
    if (browser) { try { await browser.close(); } catch (_) {} }
    browser = null; page = null;

    browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // Critical for low-RAM servers
            '--disable-gpu',
            // NOTE: --single-process and --no-zygote removed —
            // they cause "frame was detached" crashes on redirect-heavy sites
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Hide automation fingerprints
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Block heavy resources to save RAM
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    page.on('error', async err => {
        console.error('[Page crash]', err.message);
        notify('⚠️ Page crashed. Restarting...');
        await sleep(3000);
        try { await launchBrowser(); } catch (e) {
            notify(`❌ Restart failed: ${e.message}`);
        }
    });

    // ── Navigate with redirect-safe strategy ──────────────────────────────────
    // 'domcontentloaded' is used instead of 'networkidle2' because:
    // - chitchat.gg may redirect to login, which detaches the frame under networkidle2
    // - domcontentloaded fires as soon as HTML is parsed, before redirects finish loading
    try {
        await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        if (err.message.includes('detached') || err.message.includes('Navigation')) {
            // Redirect happened mid-load — wait for it to settle, then check URL
            console.warn('[goto] Frame detached during redirect — waiting for page to settle...');
            await sleep(3000);
            // Page might have landed on login or main page, either is fine
            const url = page.url();
            console.log('[goto] Settled at:', url);
            if (!url || url === 'about:blank') {
                throw new Error('Browser landed on blank page — Chrome may have crashed');
            }
            // If it settled on a real URL, we're fine — continue
        } else {
            throw err; // Unknown error — bubble up
        }
    }

    // Wait a moment for JS to boot up on the page
    await sleep(2000);
    selectorErrors = 0;

    const finalUrl = page.url();
    console.log('[Browser] Ready at:', finalUrl);

    // Warn if we ended up on a login page
    if (finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth')) {
        console.warn('[Browser] ⚠️  Landed on login page — session may have expired');
        notify('⚠️ Landed on login page. Your session expired.\nRun `npm run setup` again to re-login, then /start.');
        automationEnabled = false;
    }
}

// ─── Page Helpers (with fallbacks) ───────────────────────────────────────────

// Try multiple selectors, return first match
async function findElement(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
        try {
            const el = await page.$(sel);
            if (el) return el;
        } catch (_) {}
    }
    return null;
}

// Click a button by matching its text label
async function clickButton(labelOrLabels) {
    const labels = Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels];
    try {
        const clicked = await page.evaluate((targets) => {
            const btn = [...document.querySelectorAll('button')]
                .find(b => targets.some(t =>
                    b.innerText.trim().toLowerCase() === t.toLowerCase()
                ));
            if (btn && !btn.disabled) { btn.click(); return btn.innerText.trim(); }
            return null;
        }, labels);
        if (clicked) { console.log(`[Click] "${clicked}"`); return true; }
        return false;
    } catch { return false; }
}

async function sendChatMsg(text) {
    try {
        const sent = await page.evaluate((msg, selectors) => {
            for (const sel of selectors) {
                const ta = document.querySelector(sel);
                if (!ta) continue;
                ta.focus();
                Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                    .set.call(ta, msg);
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true, cancelable: true,
                    key: 'Enter', code: 'Enter', which: 13, keyCode: 13
                }));
                return true;
            }
            return false;
        }, text, SEL.TEXTAREA);

        if (!sent) console.warn('[sendChatMsg] Textarea not found — selectors may be outdated');
        else console.log(`[Sent] "${text}"`);
        return sent;
    } catch { return false; }
}

async function isConnected() {
    try {
        return await page.evaluate((selectors, connectedText) => {
            // 1. Try CSS selectors first
            if (selectors.some(sel => { try { return !!document.querySelector(sel); } catch { return false; } })) return true;
            // 2. Fallback: look for "You are now chatting with" anywhere on page
            return document.body?.innerText?.includes(connectedText) ?? false;
        }, SEL.CONNECTED_INDICATOR, SEL.CONNECTED_TEXT);
    } catch { return false; }
}

async function startBtnVisible() {
    try {
        return await page.evaluate((labels) => {
            const targets = Array.isArray(labels) ? labels : [labels];
            return [...document.querySelectorAll('button')]
                .some(b => targets.some(t => b.innerText.trim().toLowerCase() === t.toLowerCase()));
        }, SEL.BTN_START);
    } catch { return false; }
}

async function getStrangerMessages() {
    try {
        return await page.evaluate((myName, itemSel, senderSel, textSel) => {
            return [...document.querySelectorAll(itemSel)]
                .filter(block => {
                    const sender = block.querySelector(senderSel);
                    return sender && sender.innerText.trim() !== myName;
                })
                .map(block => {
                    const el = block.querySelector(textSel);
                    return el ? el.innerText.trim() : null;
                })
                .filter(Boolean);
        }, MY_NAME, SEL.MSG_LIST_ITEM, SEL.MSG_SENDER, SEL.MSG_TEXT);
    } catch { return []; }
}

// Check if we're on a login page (session expired)
async function isOnLoginPage() {
    try {
        return await page.evaluate(() => {
            const url = window.location.href;
            const text = document.body?.innerText || '';
            return url.includes('login') ||
                   url.includes('signin') ||
                   url.includes('auth') ||
                   text.includes('Sign in with Google') ||
                   text.includes('Log in');
        });
    } catch { return false; }
}

async function takeScreenshot() {
    try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 75 });
        return buf;
    } catch { return null; }
}

// ─── Gender Detection ─────────────────────────────────────────────────────────
const MALE_KW = [
    "m","male","boy","man","guy","dude","bro","he","him",
    "i'm a guy","i am a guy","i'm a boy","i am a boy","i'm male","i am male",
    "i'm a man","i am a man","im a guy","im male","im a man",
    "its m","m here","am male","am a guy","male here","boy here","its a m","its male"
];

const FEMALE_KW = [
    "f","female","girl","woman","lady","gal","she","her",
    "i'm a girl","i am a girl","i'm female","i am female",
    "i'm a woman","i am a woman","i'm a lady","i am a lady",
    "im a girl","im female","im a woman","its f","f here",
    "am female","am a girl","girl here","female here","its a f","its female"
];

function detectGender(raw) {
    const clean = raw.toLowerCase().trim().replace(/[^\w\s']/g, '').trim();
    // Exact single-letter match first
    if (clean === 'm') return 'male';
    if (clean === 'f') return 'female';
    // Then keyword match
    for (const kw of MALE_KW)   if (kw.length > 1 && (clean === kw || clean.includes(kw))) return 'male';
    for (const kw of FEMALE_KW) if (kw.length > 1 && (clean === kw || clean.includes(kw))) return 'female';
    return null;
}

// ─── State Machine ────────────────────────────────────────────────────────────
function clearTimers() {
    clearTimeout(connTimer);
    clearTimeout(relayIdleTimer);
}

function resetState(reason = '') {
    clearTimers();
    processedMsgs.clear();
    genderAnswered = false;
    isSkipping = false;
    state = "idle";
    if (reason) console.log(`[Reset] ${reason}`);
}

async function doSkip() {
    if (isSkipping) return;
    isSkipping = true;
    clearTimers();

    // Flow: Skip → wait → CONFIRM? → wait → now START button appears
    const skipped = await clickButton(SEL.BTN_SKIP);
    if (!skipped) {
        // Skip button not found — maybe already on confirm screen or disconnected
        // Try confirm directly in case skip was already clicked
        console.warn('[doSkip] Skip button not found, trying confirm directly...');
    }
    await sleep(SKIP_DELAY_MS);
    await clickButton(SEL.BTN_CONFIRM);  // Clicks "CONFIRM?" (red button)

    processedMsgs.clear();
    genderAnswered = false;
    stats.skipped++;
    isSkipping = false;
    state = "idle";
    console.log(`[Skip #${stats.skipped}]`);
}

async function enterRelayMode() {
    state = "relaying";
    clearTimers();

    const mins = stats.sessionStart ? Math.round((Date.now() - stats.sessionStart) / 60000) : 0;
    const shot = await takeScreenshot();
    const cap = `🎉 *FEMALE FOUND!*\n\nSession: ${mins} min | Skipped: ${stats.skipped} males\n\nRelay ON — type here to talk to her.\nUse /skip to find another, /stop to pause.`;

    if (shot) bot.sendPhoto(ADMIN_ID, shot, { caption: cap }).catch(() => notify(cap));
    else notify(cap);

    resetRelayIdle();
    console.log('[State] → relaying');
}

function resetRelayIdle() {
    clearTimeout(relayIdleTimer);
    relayIdleTimer = setTimeout(async () => {
        if (state === 'relaying') {
            notify('⏰ 3 min with no reply. Skipping...');
            await doSkip();
        }
    }, RELAY_IDLE_MS);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function mainLoop() {
    if (loopRunning || !automationEnabled || !page) return;
    loopRunning = true;

    try {
        // Check if session expired (logged out)
        if (await isOnLoginPage()) {
            automationEnabled = false;
            notify('⚠️ *Session expired!* You got logged out.\nRun `npm run setup` on server to re-login, then /start again.');
            loopRunning = false;
            return;
        }

        if (state === 'stopped' || isSkipping) return;

        const startVisible = await startBtnVisible();

        // ── Idle: press START
        if (state === 'idle') {
            if (startVisible && await clickButton(SEL.BTN_START)) {
                state = 'connecting';
                console.log('[State] → connecting');
                connTimer = setTimeout(() => {
                    if (state === 'connecting') resetState('Connect timeout');
                }, CONNECT_TIMEOUT_MS);
            }
        }

        // ── Connecting: wait for #connected-text
        else if (state === 'connecting') {
            if (startVisible) { resetState('START appeared during connect'); return; }
            if (await isConnected()) {
                clearTimeout(connTimer);
                state = 'asked';
                genderAnswered = false;
                await sendChatMsg('M or F?');
                connTimer = setTimeout(async () => {
                    if (state === 'asked') {
                        console.warn('[Timeout] No gender reply → skip');
                        await doSkip();
                    }
                }, REPLY_TIMEOUT_MS);
                console.log('[State] → asked');
            }
        }

        // ── Asked: parse gender reply
        else if (state === 'asked') {
            if (startVisible) { resetState('Stranger left during ask'); return; }

            const msgs = await getStrangerMessages();

            // If we keep getting 0 messages AND it seems connected, check selectors
            if (msgs === null) {
                selectorErrors++;
                if (selectorErrors >= 10) {
                    notify('⚠️ Message selector may be broken (got no data 10 times).\nRun: `node verify-selectors.js` on server, then update selectors.js');
                    selectorErrors = 0;
                }
            } else {
                selectorErrors = 0;
            }

            let unclears = 0;
            for (const msg of (msgs || [])) {
                if (processedMsgs.has(msg) || genderAnswered) continue;
                processedMsgs.add(msg);
                console.log(`[Received] "${msg}"`);

                const gender = detectGender(msg);
                if (gender === 'male') {
                    genderAnswered = true;
                    clearTimeout(connTimer);
                    console.log('[Male] → skip');
                    await doSkip();
                    return;
                } else if (gender === 'female') {
                    genderAnswered = true;
                    clearTimeout(connTimer);
                    console.log('[Female] → relay');
                    await enterRelayMode();
                    return;
                } else {
                    unclears++;
                    console.log(`[Unclear] "${msg}"`);
                }
            }

            // If we got unclear replies but nothing matched, ask once more
            if (unclears > 0 && !genderAnswered) {
                await sendChatMsg('M here and you ?');
            }
        }

        // ── Relaying: forward stranger messages to Telegram
        else if (state === 'relaying') {
            if (startVisible) {
                notify('⚠️ She disconnected. Restarting search...');
                resetState('Stranger left relay');
                return;
            }

            const msgs = await getStrangerMessages();
            for (const msg of (msgs || [])) {
                if (processedMsgs.has(msg)) continue;
                processedMsgs.add(msg);
                notify(`💬 *She:* ${msg}`);
                resetRelayIdle();
            }
        }

    } catch (err) {
        console.error('[Loop Error]', err.message);
    } finally {
        loopRunning = false;
    }
}

// ─── Telegram Commands ────────────────────────────────────────────────────────
function isAdmin(msg) { return msg.chat.id.toString() === ADMIN_ID.toString(); }

bot.onText(/\/start$/, async (msg) => {
    if (!isAdmin(msg)) return;
    if (automationEnabled) return notify('Already running! Use /status to check.');

    notify('🚀 Launching browser... (15-20 seconds)');
    try {
        await launchBrowser();
    } catch (e) {
        return notify(`❌ Browser failed: ${e.message}\n\nMake sure you ran: npm run setup`);
    }

    automationEnabled = true;
    state = "idle";
    stats = { skipped: 0, sessionStart: Date.now() };
    processedMsgs.clear();
    genderAnswered = false;

    notify('✅ *Bot started!* Searching...\n\n/stop · /status · /screenshot · /skip · /end');
});

bot.onText(/\/stop$/, async (msg) => {
    if (!isAdmin(msg)) return;
    automationEnabled = false;
    clearTimers();
    state = "idle";
    notify('⏹ *Paused.* Send /start to resume.');
});

bot.onText(/\/end$/, async (msg) => {
    if (!isAdmin(msg)) return;
    automationEnabled = false;
    clearTimers();
    state = "idle";
    try { await browser.close(); } catch (_) {}
    browser = null; page = null;
    notify('👋 *Fully stopped.* Send /start to restart from scratch.');
});

bot.onText(/\/status$/, async (msg) => {
    if (!isAdmin(msg)) return;
    const mins = stats.sessionStart ? Math.round((Date.now() - stats.sessionStart) / 60000) : 0;
    notify(
        `📊 *Status*\n` +
        `Running: ${automationEnabled ? '✅' : '❌'}\n` +
        `State: \`${state}\`\n` +
        `Skipped: ${stats.skipped} males\n` +
        `Uptime: ${mins} min`
    );
});

bot.onText(/\/screenshot$/, async (msg) => {
    if (!isAdmin(msg) || !page) return notify('Bot not running.');
    const shot = await takeScreenshot();
    if (shot) bot.sendPhoto(ADMIN_ID, shot, { caption: '📸 Current view' });
    else notify('❌ Screenshot failed');
});

bot.onText(/\/skip$/, async (msg) => {
    if (!isAdmin(msg)) return;
    if (!automationEnabled) return notify('Bot is not running.');
    if (!['asked','relaying','connecting'].includes(state)) return notify('Nothing to skip right now.');
    notify('⏭ Skipping...');
    await doSkip();
});

bot.onText(/\/checksels$/, async (msg) => {
    if (!isAdmin(msg) || !page) return notify('Bot not running, can\'t check selectors.');
    notify('🔍 Checking selectors...');
    const shot = await takeScreenshot();
    const allBtns = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)
    ).catch(() => []);
    const ta = await findElement(SEL.TEXTAREA);
    const connected = await isConnected();
    let report = `🔍 *Selector Check*\n`;
    report += `Textarea: ${ta ? '✅' : '❌'}\n`;
    report += `Connected: ${connected ? '✅' : '—'}\n`;
    report += `Buttons found: ${allBtns.join(', ') || 'none'}`;
    if (shot) bot.sendPhoto(ADMIN_ID, shot, { caption: report });
    else notify(report);
});

// ─── Relay: your Telegram messages → chitchat ─────────────────────────────────
bot.on('message', async (msg) => {
    if (!isAdmin(msg) || !msg.text || msg.text.startsWith('/')) return;
    if (state !== 'relaying') {
        return notify('⚠️ Not in relay mode. Bot is not connected to anyone right now.');
    }
    const sent = await sendChatMsg(msg.text);
    if (!sent) notify('❌ Send failed. The textarea selector may have changed.\nTry /checksels');
    else resetRelayIdle();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
setInterval(mainLoop, LOOP_MS);

console.log('✅ Bot ready. Send /start in Telegram to begin.');
notify('🤖 Bot server online! Send /start to begin.');