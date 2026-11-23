// Run against the diagnostic cartridge served from the packaged site.
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const path = require('node:path');
const {chromium, webkit} = createRequire(path.resolve(__dirname, '../../web/package.json'))('@playwright/test');

function observeSound() {
    // The MAME Web Audio backend receives interleaved signed 16-bit PCM.
    // Observe that boundary before host audio scheduling or resampling.
    let forward;
    window.diagnosticSamples = 0;
    Object.defineProperty(window, 'jsmame_stream_sink_update', {
        set(callback) { forward = callback; },
        get() { return observeBuffer; },
    });
    function observeBuffer(address, count) {
        const samples = window.HEAP16;
        const offset = address / 2;
        const periods = [];
        let last = -1;
        for (let i = 1; i < count; i++) {
            if (samples[offset + 2*i - 2] <= 0 && samples[offset + 2*i] > 0) {
                if (last >= 0) periods.push(i - last);
                last = i;
            }
        }
        if (periods.length >= 2) {
            periods.sort((a, b) => a - b);
            window.lastDiagnosticPitch = Module.gameAudioContext.sampleRate /
                periods[Math.floor(periods.length / 2)];
        }
        window.diagnosticSamples += count;
        return forward(address, count);
    }
}

async function expectPitch(page, mask) {
    const expected = 1789773 / (16 * (0x181 + 8 * mask));
    try {
        await page.waitForFunction(pitch => Module.gameAudioContext.state === 'running' &&
            Math.abs(window.lastDiagnosticPitch - pitch) < 2, expected, {timeout: 45000});
    } catch (error) {
        const observed = await page.evaluate(() => ({
            pitch: window.lastDiagnosticPitch,
            samples: window.diagnosticSamples,
            status: document.querySelector('output').textContent,
            focus: document.activeElement.id,
        }));
        throw new Error('Missing tone for input mask ' + mask + ': ' + JSON.stringify(observed), {cause: error});
    }
}

async function pressMenuKeys(page, keys) {
    for (const key of keys) {
        await page.keyboard.down(key);
        await page.waitForTimeout(140);
        await page.keyboard.up(key);
        await page.waitForTimeout(350);
    }
}

async function verify(browserType, url) {
    const browser = await browserType.launch();
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
            if (response.status() >= 400) errors.push(response.url());
        });
        await page.addInitScript(observeSound);
        await page.goto(url);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
            const screen = document.querySelector('canvas');
            return !screen.hidden && screen.width > 0 && screen.height > 0;
        });

        await page.evaluate(() => {
            const sample = document.createElement('canvas');
            sample.width = sample.height = 1;
            const pixel = sample.getContext('2d', {willReadFrequently: true});
            const colors = new Set();
            const source = document.querySelector('canvas');
            window.hasDiagnosticFrames = () => {
                pixel.drawImage(source, source.width >> 1, source.height >> 1, 1, 1, 0, 0, 1, 1);
                colors.add(pixel.getImageData(0, 0, 1, 1).data.join(','));
                return colors.size >= 4;
            };
        });
        await page.waitForFunction(() => window.hasDiagnosticFrames(), null, {timeout: 90000});
        assert.deepEqual(errors, []);
        await expectPitch(page, 0);
        await page.keyboard.down('j');
        await expectPitch(page, 1);
        await page.keyboard.down('n');
        await expectPitch(page, 3);
        await page.keyboard.up('j');
        await expectPitch(page, 2);
        await page.keyboard.up('n');
        // Allow two 60-frame rewind checkpoints to accumulate before opening the menu.
        await page.waitForFunction(() => window.diagnosticSamples >= 3 * Module.gameAudioContext.sampleRate,
            null, {timeout: 180000});
        await pressMenuKeys(page, ['r']);
        await page.waitForFunction(() => document.querySelector('output').textContent === 'Game rewound.');
        await page.keyboard.down('j');
        await expectPitch(page, 1);
        await page.keyboard.up('j');
        await pressMenuKeys(page, ['Escape', 'Home', 'Enter', 'Home', 'Enter', 'Enter']);
        await page.waitForFunction(() => document.querySelector('output').textContent === 'Game saved.');
        await page.reload();
        await page.keyboard.press('Enter');
        await expectPitch(page, 0);
        await pressMenuKeys(page, ['Escape', 'Home', 'ArrowDown', 'Enter', 'Home', 'Enter']);
        await page.waitForFunction(() => document.querySelector('output').textContent === 'Game loaded.');
        assert.deepEqual(errors, []);
        console.log(browserType.name() + ' verified video, both ports, four tones and persistent save/load');
    } finally {
        await browser.close();
    }
}

(async () => {
    const url = process.argv[2];
    if (!url) throw new Error('Expected the URL of the packaged diagnostic site');
    for (const browser of [chromium, webkit]) await verify(browser, url);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
