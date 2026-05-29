// selectors.js — Update this file if the site changes its HTML
// Run: node verify-selectors.js to test all selectors live

module.exports = {

    // ── Button labels (exact text on the button) ────────────────────────────
    //
    // FLOW: "Start Text Chat" → [chatting] → "Skip" → "CONFIRM?" → "START" → repeat
    //
    BTN_START:   ["Start Text Chat", "START", "Start"],  // Home page OR after confirm
    BTN_SKIP:    ["Skip", "SKIP"],                       // While in a chat
    BTN_CONFIRM: ["CONFIRM?", "CONFIRM", "Confirm"],     // Red button after skip (has ? in it)
    BTN_ESC:     "ESC",                                  // Cancel skip — bot never clicks this

    // ── Connected indicator ─────────────────────────────────────────────────
    // Visible only while matched with a stranger.
    // From screenshot: page shows "You are now chatting with X. Say hi!"
    CONNECTED_INDICATOR: [
        "#connected-text",                          // Original guess
        "[data-connected='true']",
        ".connected-status",
        // Text-based fallback — checks if the "chatting with" message exists
        // handled separately in isConnected() via page.evaluate
    ],

    // Text that appears on page when connected (used as fallback detection)
    CONNECTED_TEXT: "You are now chatting with",

    // ── Message textarea ────────────────────────────────────────────────────
    TEXTAREA: [
        'textarea[placeholder="Send a message"]',
        'textarea[placeholder="Type a message"]',
        'textarea[placeholder="Message"]',
        'textarea.chat-input',
        'textarea',
    ],

    // ── Stranger message blocks ─────────────────────────────────────────────
    MSG_LIST_ITEM:  "li.select-text",
    MSG_SENDER:     "h3 span.link",
    MSG_TEXT:       ".emoji-content",
};