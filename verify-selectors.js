/**
 * verify-selectors.js — Run this whenever the site updates to check
 * which selectors are broken, and get hints on what the new ones might be.
 *
 * Usage: node verify-selectors.js
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const SEL = require('./selectors');
const path = require('path');

puppeteer.use(StealthPlugin());
const PROFILE_DIR = path.resolve(__dirname, 'chrome-profile');

async function verify() {
    console.log('\n🔍 Verifying selectors against live site...\n');

    const browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();

    try {
        await page.goto('https://app.chitchat.gg', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('✅ Page loaded\n');

        // 1. Check textarea
        console.log('── Textarea ──────────────────────────────');
        for (const sel of SEL.TEXTAREA) {
            const found = await page.$(sel);
            console.log(`  ${found ? '✅' : '❌'} ${sel}`);
        }

        // 2. Check connected indicator
        console.log('\n── Connected Indicator ───────────────────');
        console.log('  (Will show ❌ unless you\'re in an active chat)');
        for (const sel of SEL.CONNECTED_INDICATOR) {
            const found = await page.$(sel);
            console.log(`  ${found ? '✅' : '❌'} ${sel}`);
        }

        // 3. Check START button by text
        console.log('\n── Buttons ───────────────────────────────');
        const startFound = await page.evaluate((txt) => {
            return [...document.querySelectorAll('button')]
                .some(b => b.innerText.trim() === txt);
        }, SEL.BTN_START);
        console.log(`  ${startFound ? '✅' : '❌'} Button text: "${SEL.BTN_START}"`);

        // 4. Dump all button texts found on page
        const allButtons = await page.evaluate(() =>
            [...document.querySelectorAll('button')]
                .map(b => b.innerText.trim())
                .filter(t => t.length > 0)
        );
        console.log('\n── All button texts currently on page ────');
        allButtons.forEach(t => console.log(`  → "${t}"`));

        // 5. Check message container
        console.log('\n── Message containers ────────────────────');
        const msgCount = await page.evaluate((sel) =>
            document.querySelectorAll(sel).length
        , SEL.MSG_LIST_ITEM);
        console.log(`  Found ${msgCount} message blocks with selector: ${SEL.MSG_LIST_ITEM}`);

        // 6. Dump page structure hints if things are broken
        console.log('\n── Page structure hints ──────────────────');
        const hints = await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map(el => `#${el.id}`).slice(0, 20);
            const classes = [...new Set(
                [...document.querySelectorAll('[class]')]
                    .map(el => `.${[...el.classList][0]}`)
                    .filter(Boolean)
            )].slice(0, 30);
            return { ids, classes };
        });
        console.log('  IDs:', hints.ids.join(', ') || 'none');
        console.log('  Classes:', hints.classes.join(', ') || 'none');

        // 7. Screenshot
        await page.screenshot({ path: 'selector-check.jpg', type: 'jpeg', quality: 80 });
        console.log('\n📸 Screenshot saved: selector-check.jpg\n');

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await browser.close();
    }

    console.log('Done. Update selectors.js if anything shows ❌');
    console.log('Then re-run this script to confirm.\n');
}

verify();
