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
                Module.arguments.push('-autoboot_delay','0','-autoboot_script','/ending.lua');
                Module.preRun = [() => {
                    FS.writeFile('/ending.lua', lua);
                    FS.writeFile('/game.lbl', labels);
                    Object.assign(ENV, {BATTLECITY_LABELS:'/game.lbl', BATTLECITY_SCENARIO:'base',
                        BATTLECITY_AV_TRACE:'/events.csv', BATTLECITY_END_INPUT:route});
                }];
                const blocks = [];
                window.endingPcm = blocks;
                let sink;
                Object.defineProperty(window, 'jsmame_stream_sink_update', {
                    set(fn) { sink=fn; },
                    get() { return (address,frames) => {
                        // Copy before the game reuses its signed interleaved stereo buffer.
                        blocks.push(HEAPU8.slice(address,address+4*frames));
                        return sink(address,frames);
                    }; }
                });
                Module.print = message => {
                    if (message.startsWith('BATTLECITY_ENDING_')) window.endingResult = message;
                };
            }, {lua, labels, route});
            await page.click('#start');
            await page.waitForFunction(() => window.endingResult, null, {timeout:150000});
            const capture = await page.evaluate(() => {
                const bytes = new Uint8Array(endingPcm.reduce((n,b)=>n+b.length,0));
                let at=0;
                for (const block of endingPcm) { bytes.set(block,at); at+=block.length; }
                let binary = '';
                for (let i=0; i<bytes.length; i+=16384)
                    binary += String.fromCharCode(...bytes.subarray(i, i+16384));
                return {result:window.endingResult, trace:FS.readFile('/events.csv', {encoding:'utf8'}), pcm:btoa(binary),rate:Module.gameAudioContext.sampleRate};
            });
            assert.equal(capture.result, 'BATTLECITY_ENDING_OK');
            assert.ok(capture.trace.includes(',cue-24,') && capture.trace.includes(',title,'));
            const out = path.join(directory, 'web-'+route);
            fs.mkdirSync(out, {recursive:true});
            fs.writeFileSync(path.join(out, 'events.csv'),capture.trace);
            const pcm = Buffer.from(capture.pcm, 'base64');
            assert.ok(pcm.length > 20*4*capture.rate && pcm.length%4===0);
            const header = Buffer.alloc(44);
            header.write('RIFF'); header.writeUInt32LE(pcm.length+36,4); header.write('WAVEfmt ',8);
            header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(2,22);
            header.writeUInt32LE(capture.rate,24); header.writeUInt32LE(capture.rate*4,28);
            header.writeUInt16LE(4,32); header.writeUInt16LE(16,34); header.write('data',36);
            header.writeUInt32LE(pcm.length,40);
            fs.writeFileSync(path.join(out, 'game.wav'), Buffer.concat([header,pcm]));
            await page.close();
            console.log('Web ending recorded', route);
        }
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
