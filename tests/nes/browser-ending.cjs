// Record the actual release core mixer while the cartridge plays each base-loss path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {chromium} = createRequire(path.resolve(__dirname, '../../web/package.json'))('@playwright/test');
const [url, labelsPath, directory] = process.argv.slice(2);
const lua = fs.readFileSync(path.join(__dirname, 'ending.lua'), 'utf8');
const labels = fs.readFileSync(labelsPath, 'utf8');

(async () => {
    const browser = await chromium.launch();
    try {
        for (const route of ['neutral', 'record', 'skip-over']) {
            const page = await browser.newPage({viewport:{width:640,height:480}});
            await page.goto(url);
            await page.evaluate(({lua, labels, route}) => {
                Module.arguments.push('-autoboot_delay','0','-autoboot_script','/ending.lua','-wavwrite','/ending.wav');
                Module.preRun = [() => {
                    FS.writeFile('/ending.lua', lua);
                    FS.writeFile('/game.lbl', labels);
                    Object.assign(ENV, {BATTLECITY_LABELS:'/game.lbl', BATTLECITY_SCENARIO:'base',
                        BATTLECITY_AV_TRACE:'/events.csv', BATTLECITY_END_INPUT:route});
                }];
                Module.print = message => {
                    if (message.startsWith('BATTLECITY_ENDING_')) window.endingResult = message;
                };
            }, {lua, labels, route});
            await page.click('#start');
            await page.waitForFunction(() => window.endingResult, null, {timeout:150000});
            const capture = await page.evaluate(() => {
                const bytes = FS.readFile('/ending.wav');
                let binary = '';
                for (let i=0; i<bytes.length; i+=16384)
                    binary += String.fromCharCode(...bytes.subarray(i, i+16384));
                return {result:window.endingResult, trace:FS.readFile('/events.csv', {encoding:'utf8'}), wav:btoa(binary)};
            });
            assert.equal(capture.result, 'BATTLECITY_ENDING_OK');
            assert.ok(capture.trace.includes(',cue-24,') && capture.trace.includes(',title,'));
            const out = path.join(directory, 'web-'+route);
            fs.mkdirSync(out, {recursive:true});
            fs.writeFileSync(path.join(out, 'events.csv'),capture.trace);
            fs.writeFileSync(path.join(out, 'game.wav'), Buffer.from(capture.wav, 'base64'));
            await page.close();
            console.log('Web ending recorded', route);
        }
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
