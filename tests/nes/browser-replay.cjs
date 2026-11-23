// Run the same cartridge and Lua trace used by the Linux host replay check.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const {chromium} = createRequire(path.resolve(__dirname, '../../web/package.json'))('@playwright/test');

async function compareReplay(url) {
    const script = readFileSync(path.join(__dirname, 'replay.lua'), 'utf8')
        .replace('"probe.frames"', '"/local/probe.frames"');
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        for (const cold of ['0', '1']) {
            await page.goto(url);
            await page.evaluate(({cold, script}) => {
                Module.arguments.push('-autoboot_delay', '0', '-autoboot_script', '/probe.lua');
                Module.preRun = [() => {
                    ENV.BATTLECITY_COLD_REPLAY = cold;
                    FS.writeFile('/probe.lua', script);
                }];
                Module.print = message => {
                    if (String(message).includes('MAME_REPLAY')) window.replayResult = message;
                };
            }, {cold, script});
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.replayResult, null, {timeout: 180000});
            const [marker, digest] = await page.evaluate(async () => {
                await new Promise((resolve, reject) => FS.syncfs(false, error => error ? reject(error) : resolve()));
                const hash = await crypto.subtle.digest('SHA-256', FS.readFile('/local/probe.frames'));
                return [window.replayResult, Array.from(new Uint8Array(hash),
                    byte => byte.toString(16).padStart(2, '0')).join('')];
            });
            assert.equal(marker, 'MAME_REPLAY_OK');
            assert.equal(digest, '4c3f9d1aadba3e6c1501fa1c5063064360365a47d944936f40388639f90a83bd');
            console.log(cold === '1' ? 'Cold replay verified' : 'Warm replay verified', digest);
        }
    } finally {
        await browser.close();
    }
}
compareReplay(process.argv[2]).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
