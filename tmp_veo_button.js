const { chromium } = require('playwright');
(async () => {
    try {
        const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const contexts = browser.contexts();
        for (const ctx of contexts) {
            for (const page of ctx.pages()) {
                if (page.url().includes('labs.google/fx/vi/tools/flow')) {
                    const texts = await page.locator('span, div, a, button').evaluateAll(els =>
                        els.map(e => e.innerText && e.innerText.trim()).filter(t => t && t.length > 0 && t.length < 50)
                    );
                    const uniq = [...new Set(texts)];
                    console.log(uniq);
                    process.exit(0);
                }
            }
        }
    } catch (e) { }
    setTimeout(() => process.exit(1), 5000);
})();
