// Measure the emulated screen and produced PCM through a served release ZIP.
const assert = require('node:assert/strict');
const path = require('node:path');
const {createRequire} = require('node:module');
const engines = createRequire(path.resolve(__dirname, '../../web/package.json'))('@playwright/test');
const [url, engine, cadence = 'native', duration = '30', repeats = '3'] = process.argv.slice(2);
const inputs = require('node:fs').readFileSync(path.join(__dirname,'clock-input.lua'),'utf8');
const observer = inputs + `\nlocal m=manager.machine
local tick=0
clock_observer=emu.add_machine_frame_notifier(function()
    tick=tick+1
    if tick%6~=0 then return end
    print(string.format("CLOCK %.8f %d",m.time:as_double(),m.screens[":screen"]:frame_number()))
end)`;

async function measure() {
    const browser = await engines[engine].launch();
    try {
        const page = await browser.newPage({viewport: {width: 640, height: 480}});
        page.on('pageerror', error => console.error(error));
        page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
        await page.goto(url);
        await page.evaluate(({observer, cadence}) => {
            if (cadence !== 'native') {
                const period = 1000 / Number(cadence);
                const origin = performance.now();
                window.requestAnimationFrame = callback => {
                    const now = performance.now();
                    const deadline = origin + (1 + Math.floor((now-origin)/period))*period;
                    return setTimeout(() => callback(performance.now()), Math.max(1, Math.ceil(deadline-now)));
                };
                window.cancelAnimationFrame = clearTimeout;
            }
            Module.arguments.push('-autoboot_delay','0','-autoboot_script','/clock.lua');
            Module.preRun = [() => FS.writeFile('/clock.lua', observer)];
            let sink, pcm = 0;
            Object.defineProperty(window, 'jsmame_stream_sink_update', {
                set(fn) { sink = fn; },
                get() { return (address, frames) => { pcm += frames; return sink(address, frames); }; }
            });
            Module.print = line => {
                if (!String(line).startsWith('CLOCK ')) { if (/error/i.test(line)) console.error(line); return; }
                const [,emu,frame] = line.split(' ');
                window.clockSample = {wall: performance.now()/1000, emu: Number(emu), frame: Number(frame),
                    pcm, rate: Module.gameAudioContext.sampleRate, context: Module.gameAudioContext.state};
            };
        }, {observer, cadence});
        await page.click('#start');
        await page.waitForFunction(() => window.clockSample?.emu >= 9, null, {timeout:90000});
        let start = await page.evaluate(() => clockSample);
        let passed = true;
        for (let run=1; run<=Number(repeats); run++) {
            await page.waitForTimeout(Number(duration)*1000);
            const end = await page.evaluate(() => clockSample);
            assert.equal(end.context, 'running');
            const wall = end.wall-start.wall;
            const emu = end.emu-start.emu;
            const pcm = (end.pcm-start.pcm)/end.rate;
            const row = {engine, cadence, run, wall, emu, frames:end.frame-start.frame, pcm,
                sampleRate:end.rate, speed:emu/wall, audioSpeed:pcm/wall};
            console.log(JSON.stringify(row));
            passed &&= wall >= Number(duration)*.95 && Math.abs(row.speed-1)<=.01 && Math.abs(row.audioSpeed-1)<=.01;
            start = end;
        }
        if (cadence === 'native') {
            async function escape() {
                await page.keyboard.down('Escape');
                await page.waitForTimeout(150);
                await page.keyboard.up('Escape');
            }
            await escape();
            await page.waitForFunction(() => document.querySelector('#display').dataset.menu==='1');
            const paused = await page.evaluate(() => clockSample.emu);
            await page.waitForTimeout(750);
            assert.ok(Math.abs(await page.evaluate(() => clockSample.emu)-paused)<.12, 'system menu advanced game time');
            await escape();
            await page.waitForFunction(() => document.querySelector('#display').dataset.menu==='0');
            await page.waitForFunction(t => clockSample.emu>t+.15, paused);
            // Desktop headless engines do not expose tab suspension uniformly.
            // Deliver the same DOM visibility transition to the packaged runtime.
            const hidden = await page.evaluate(() => {
                Object.defineProperty(document,'hidden',{configurable:true,value:true});
                document.dispatchEvent(new Event('visibilitychange'));
                return clockSample.emu;
            });
            await page.waitForTimeout(1500);
            assert.equal(await page.evaluate(() => clockSample.emu), hidden);
            await page.evaluate(() => {
                delete document.hidden;
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await page.waitForFunction(t => clockSample.emu>t, hidden);
            const resumed = await page.evaluate(() => clockSample.emu);
            assert.ok(resumed-hidden<.35, 'background time was replayed');
            console.log(JSON.stringify({engine, lifecycle:'menu and simulated visibility resume', resumeAdvance:resumed-hidden}));
        }
        assert.ok(passed, 'emulated or PCM time differed from wall time by more than 1%');
    } finally {
        await browser.close();
    }
}
measure().catch(error => {console.error(error); process.exitCode=1;});
