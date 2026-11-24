// Exercise the delivered Web entry with real keyboard events. The observer
// only reads cartridge RAM, so it cannot advance the game or satisfy assertions.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const {chromium, webkit} = createRequire(path.resolve(__dirname, '../../web/package.json'))('@playwright/test');
const url = process.argv[2];
const labels = readFileSync(process.argv[3] || 'build/mame-runtime/web/game.lbl', 'utf8');
const addresses = Object.fromEntries([...labels.matchAll(/^al ([\da-f]+) \._(\w+)$/gmi)]
    .map(([, address, name]) => [name, parseInt(address, 16)]));
const fields = [['mode'], ['selection'], ['stage'], ['players'], ['frame'], ['tanks',1],
    ['tanks',14], ['cursor_x'], ['design',1], ['board',1], ['shots',3], ['shots',7], ['tanks',11],['title_scroll'],['battle_ticks',1]];
const reads = fields.map(([name, offset = 0]) => {
    assert.ok(Number.isInteger(addresses[name]), name);
    return 'ram:read_u8(' + (addresses[name] + offset) + ')';
});
const menuKeys = ['Escape', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Enter', 'r', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'];
const menuCodes = ['ESC', 'HOME', 'END', 'UP', 'DOWN', 'ENTER', 'R', 'LEFT', 'RIGHT', 'DEL', 'BACKSPACE'];
const observer = `local ram=manager.machine.devices[":maincpu"].spaces.program
game_observer=emu.add_machine_frame_notifier(function()
    print("GAME_STATE "..table.concat({${reads.join(',')}},","))
end)
local input=manager.machine.input
local io=manager.machine.ioport
local selectType=io:token_to_input_type("UI_SELECT")
local codes={${menuCodes.map(key => "input:code_from_token('KEYCODE_" + key + "')").join(',')}}
emu.register_frame_done(function()
    local mask=0
    for i,code in ipairs(codes) do
        if input:code_pressed(code) then mask=mask | (1<<(i-1)) end
    end
    print("INPUT_FRAME "..(manager.ui.menu_active and "1 " or "0 ")..mask.." "..(io:type_pressed(selectType) and 1 or 0))
end)`;

async function start(page) {
    await page.goto(url);
    await page.evaluate(script => {
        // Read MAME's selected row from the rendered highlight. SDL reports
        // raw key state before the paused UI has necessarily acted on it.
        const strip = document.createElement('canvas');
        strip.width = 120; strip.height = 160;
        const ctx = strip.getContext('2d', {willReadFrequently: true});
        window.selectedMenuRow = () => {
            if (!window.menuActive) return -1;
            const screen = document.querySelector('canvas');
            ctx.drawImage(screen, screen.width * .4, screen.height * .35,
                screen.width * .2, screen.height * .3, 0, 0, strip.width, strip.height);
            const pixels = ctx.getImageData(0, 0, strip.width, strip.height).data;
            for (let y = 0; y < strip.height; y++) {
                let highlighted = 0;
                for (let x = 0; x < strip.width; x++) {
                    const i = 4 * (y * strip.width + x);
                    if (pixels[i] > 75 && Math.abs(pixels[i] - pixels[i+1]) < 12 && pixels[i+2] < 35)
                        highlighted++;
                }
                if (highlighted > strip.width / 2) return y;
            }
            return -1;
        };
        Module.arguments.push('-autoboot_delay','0','-autoboot_script','/observe.lua');
        Module.preRun = [() => FS.writeFile('/observe.lua', script)];
        Module.print = message => {
            if (String(message).startsWith('INPUT_FRAME ')) {
                const [, active, keys, select] = message.split(' ');
                window.uiSelectPressed = select === '1';
                window.menuActive = active === '1';
                window.menuKeysHeld = Number(keys);
                window.presentationFrame = (window.presentationFrame || 0) + 1;
                if (window.menuSample) window.menuSample();
                return;
            }
            if (!String(message).startsWith('GAME_STATE ')) return;
            const [mode, selection, stage, players, frame, y1, y2, cursor, design, board, shot1, shot2, shield, titleScroll, idleTimer] =
                message.slice(11).split(',').map(Number);
            window.gameState = {mode, selection, stage, players, frame, y1, y2, cursor, design, board, shot1, shot2, shield, titleScroll, idleTimer};
            if (shot1) window.seenShot1 = true;
            if (shot2) window.seenShot2 = true;
        };
    }, observer);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.gameState?.mode === 0 && gameState.idleTimer > 0 && gameState.titleScroll === 0, null, {timeout: 120000});
    // The emulator can start writing RAM before the first frame reaches SDL.
    await page.waitForFunction(() => {
        const sample = document.createElement('canvas');
        sample.width = 80; sample.height = 60;
        const ctx = sample.getContext('2d');
        ctx.drawImage(document.querySelector('canvas'), 0, 0, 80, 60);
        return ctx.getImageData(0,0,80,60).data.some((value, index) => index % 4 !== 3 && value > 80);
    }, null, {timeout: 30000});
}

async function press(page, key, expected) {
    await page.keyboard.down(key);
    try {
        await page.waitForFunction(expected, null, {timeout: 30000});
    } catch (error) {
        throw new Error(key + ' failed at ' + JSON.stringify(await page.evaluate(() => window.gameState)), {cause: error});
    } finally {
        await page.keyboard.up(key);
    }
    // Each new edge must reach the NES after it has sampled the release.
    const frame = await page.evaluate(() => window.gameState.frame);
    await page.waitForFunction(previous => ((gameState.frame - previous + 256) % 256) >= 3, frame);
}

async function checkShooterPreview(page, mode) {
    const bounds = await page.evaluate(() => {
        const sample=document.createElement('canvas');
        sample.width=1280; sample.height=720;
        const ctx=sample.getContext('2d');
        ctx.drawImage(Module.canvas,0,0,1280,720);
        const pixels=ctx.getImageData(0,0,1280,720).data;
        return [[640,218], ...[307,529,750,972].map(x=>[x,410])].map(([cx,cy]) => {
            const xs=[],ys=[];
            for(let y=cy-86;y<=cy+86;++y) for(let x=cx-138;x<=cx+138;++x) {
                const i=(y*1280+x)*4;
                const [r,g,b]=[pixels[i],pixels[i+1],pixels[i+2]];
                if ((r>65 && g>120 && b<50) || (r>39 && r<85 && g<91 && b>155)) {
                    xs.push(x); ys.push(y);
                }
            }
            return [Math.max(...xs)-Math.min(...xs)+1,Math.max(...ys)-Math.min(...ys)+1];
        });
    });
    const sizes=[[76,56],[86,75],[65,56],[134,75]];
    const expected=[[sizes[mode][0]*164/86,sizes[mode][1]*144/75], ...sizes];
    bounds.forEach((actual,i) => actual.forEach((v,j) =>
        assert.ok(Math.abs(v-expected[i][j])<6, 'preview '+i+' expected '+expected[i]+' measured '+actual)));
}

async function checkScreenMode(page, mode) {
    try {
        await page.waitForFunction(expected => document.querySelector('#display').dataset.mode === expected,
            mode, {timeout: 7000});
    } catch (cause) {
        await capture(page, 'display-mode-' + mode);
        throw new Error('Display input ' + JSON.stringify(await page.evaluate(() => window.menuSteps)), {cause});
    }
}

async function slotDigest(page, slot) {
    return page.evaluate(async number => {
        const root = Module.arguments[Module.arguments.indexOf('-state_directory') + 1];
        const bytes = FS.readFile(root + '/nes/' + number + '.sta');
        if (!bytes.length) throw new Error('Empty save in slot ' + number);
        const preview = FS.readFile(root + '/nes/' + number + '.sta.png');
        if (preview[0] !== 137 || preview[1] !== 80 || preview[2] !== 78 || preview[3] !== 71)
            throw new Error('Missing slot preview ' + number);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).join(',');
    }, slot);
}

async function capture(page, name) {
    const directory = process.env.BATTLECITY_CAPTURE_DIR;
    if (!directory && name !== 'stage-1') return;
    if (name === 'stage-1') {
        // Capture the unshielded tank after the opening sequence.
        await page.waitForFunction(() => gameState.mode === 1 && gameState.shield === 0, null, {timeout: 60000});
        await renderFrames(page, 2);
    }
    const screenshot = await page.screenshot(directory ? {path: path.join(directory, name + '.png')} : {});
    if (name !== 'stage-1') return;
    const counts = await page.evaluate(async data => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + data;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        function count(x, y, w, h, r, g, b) {
            const pixels = ctx.getImageData(x, y, w, h).data;
            let matches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i] === r && pixels[i+1] === g && pixels[i+2] === b) ++matches;
            }
            return matches;
        }
        return [
            count(248, 70, 36, 560, 98, 98, 98),
            count(342, 430, 50, 148, 147, 64, 0),
            count(342, 430, 50, 148, 93, 0, 0),
            count(590, 215, 49, 37, 165, 165, 165)
        ];
    }, screenshot.toString('base64'));
    assert.ok(counts[0] === 20160 && counts.slice(1).every(n => n > 100),
        'Switch reference colours on the border, brick and steel: ' + counts);
}

// Wait for MAME to present the press and its release even while the player
// menu has paused the NES. A browser animation frame can precede SDL input.
async function renderFrames(page, count) {
    const initial = await page.evaluate(() => window.presentationFrame || 0);
    await page.waitForFunction(end => (window.presentationFrame || 0) >= end, initial + count);
}

async function menu(page, keys, message) {
    await page.evaluate(() => { document.querySelector('output').textContent = ''; });
    await page.locator('canvas').focus();
    for (const key of keys) {
        assert.ok(menuKeys.includes(key), key);
        const bit = 1 << menuKeys.indexOf(key);
        // Release from the first SDL sample. Polling from Playwright while
        // holding an arrow can trigger MAME's wall-clock autorepeat on slow hosts.
        await page.evaluate(({bit, key}) => {
            window.menuEdge = new Promise((resolve, reject) => {
                let frames = 0;
                const timer = setTimeout(() => {
                    window.menuSample = null;
                    reject(new Error('No input sample for ' + key));
                }, 30000);
                window.menuSample = () => {
                    if (!(window.menuKeysHeld & bit)) return;
                    if (key === 'Escape' && !window.menuActive) return;
                    if (key === 'Enter' && !window.uiSelectPressed) return;
                    if ((key === 'Enter' || key === 'Backspace') && ++frames < 6) return;
                    clearTimeout(timer);
                    window.menuSample = null;
                    resolve(true);
                };
            });
        }, {bit, key});
        await page.keyboard.down(key);
        try {
            await page.evaluate(() => window.menuEdge);
        } catch (cause) {
            await capture(page, 'menu-' + key);
            throw new Error('Menu did not sample ' + key + ' in ' + keys.join(' '), {cause});
        } finally {
            await page.keyboard.up(key);
        }
        await page.waitForFunction(() => window.menuKeysHeld === 0);
        await renderFrames(page, 3);
        await page.evaluate(key => {
            (window.menuSteps ||= []).push([key, window.menuActive, window.selectedMenuRow(),
                document.querySelector('#display').dataset.mode]);
        }, key);
    }
    if (!message) return;
    try {
        await page.waitForFunction(value => document.querySelector('output').textContent === value,
            message, {timeout: 30000});
    } catch (error) {
        await capture(page, 'menu-failure');
        const status = await page.locator('output').textContent();
        throw new Error('Menu expected ' + message + ', got ' + JSON.stringify(status), {cause: error});
    }
}

// Observe the game's signed stereo PCM before Web Audio schedules it.
function observeSound() {
    let output;
    window.activeAudioBuffers = 0;
    Object.defineProperty(window, 'jsmame_stream_sink_update', {
        set(callback) { output = callback; },
        get() { return inspect; },
    });
    function inspect(address, frames) {
        const pcm = window.HEAP16;
        const start = address / 2;
        let low = 32767, high = -32768;
        for (let i = 0; i < frames; i++) {
            const value = pcm[start + i * 2];
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
        if (high - low > 128) window.activeAudioBuffers++;
        return output(address, frames);
    }
}

async function verifyScenarios(page, suite, players = 1, scenario = '') {
    const script = readFileSync(path.join(__dirname, suite + '.lua'), 'utf8');
    const goldens = suite === 'audio' ?
        readFileSync(path.join(__dirname, '../../web/tests/platform/audio-driver.test.ts'), 'utf8') :
        ['combat','ending','campaign'].includes(suite) ?
            readFileSync(path.join(__dirname, 'fixtures', suite, scenario + '.csv'), 'utf8') : '';
    const inputs = suite === 'campaign' ?
        readFileSync(path.join(__dirname, 'fixtures/campaign', scenario + '.pads'), 'utf8') : '';
    const marker = 'BATTLECITY_' + suite.toUpperCase() + '_';
    await page.setViewportSize({width: 640, height: 480});
    await page.goto(url);
    await page.evaluate(({script, labels, goldens, inputs, marker, players, scenario}) => {
        // MAME advances one emulated frame per callback. Scripted fixtures use
        // its own frame counter and NES pixel buffer, including save/load.
        // Keep real-time canvas and audio presentation in the controls suite.
        window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
        window.cancelAnimationFrame = clearTimeout;
        Module.arguments.push('-video', 'none', '-sound', 'none');
        Module.arguments.push('-autoboot_delay', '0', '-autoboot_script', '/suite.lua');
        Module.preRun = [() => {
            ENV.BATTLECITY_LABELS = '/game.lbl';
            ENV.BATTLECITY_PLAYERS = String(players);
            ENV.BATTLECITY_SCENARIO = scenario;
            FS.writeFile('/game.lbl', labels);
            FS.writeFile('/suite.lua', script);
            if (inputs) {
                FS.writeFile('/input.pads', inputs);
                ENV.BATTLECITY_INPUT = '/input.pads';
            }
            if (goldens) {
                ENV.BATTLECITY_GOLDENS = '/goldens.ts';
                FS.writeFile('/goldens.ts', goldens);
            }
        }];
        Module.print = message => {
            if (String(message).startsWith('OPENING_TRACE')) window.openingTrace = message;
            if (String(message).startsWith(marker)) window.scenarioResult = message;
        };
    }, {script, labels, goldens, inputs, marker, players, scenario});
    await page.keyboard.press('Enter');
    // Genuine automatic tally and intermissions take over seven emulated minutes.
    const timeout = suite === 'game' ? 1800000 : suite === 'campaign' ? 600000 : 360000;
    await page.waitForFunction(() => window.scenarioResult, null, {timeout, polling: 100});
    const result = await page.evaluate(() => window.scenarioResult);
    assert.equal(result, marker + (suite === 'audio' ? 'OK 27 full APU register traces' : 'OK'));
    if (suite === 'opening') console.log(await page.evaluate(() => window.openingTrace));
    console.log('Chromium WebAssembly passed ' + result + (scenario ? ' ' + scenario : ''));
}

async function verifyCombat(page) {
    for (const scenario of ['idle', 'solo', 'coop', 'drops']) {
        await verifyScenarios(page, 'combat', scenario === 'coop' ? 2 : 1, scenario);
    }
}

async function verify(engine, suite) {
    const browser = await engine.launch();
    try {
        const page = await browser.newPage();
        if (suite === 'ending' || suite === 'campaign') {
            const cases = suite === 'ending' ? ['solo','coop','base','lives'] : ['solo','coop'];
            for (const scenario of cases) await verifyScenarios(page, suite, scenario === 'coop' ? 2 : 1, scenario);
            return;
        }
        if (suite === 'combat') {
            await verifyCombat(page);
            return;
        }
        if (suite && suite !== 'controls') {
            await verifyScenarios(page, suite);
            if (suite === 'opening') await verifyScenarios(page, suite, 2);
            return;
        }
        await page.addInitScript(observeSound);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await start(page);
        await capture(page, 'title');
        await press(page, 'Enter', () => gameState.mode === 6);
        await press(page, 'j', () => gameState.stage === 1);
        await press(page, 'k', () => gameState.stage === 0);
        const beforeIntro = await page.evaluate(() => window.activeAudioBuffers);
        await press(page, 'Enter', () => gameState.mode === 1 && gameState.players === 1);
        await page.waitForFunction(before => Module.gameAudioContext.state === 'running' &&
            window.activeAudioBuffers >= before + 4, beforeIntro, {timeout: 30000});
        await press(page, 'w', () => gameState.y1 < 188);
        for (const [width, height] of [[1280,720], [1920,1080]]) {
            await page.setViewportSize({width, height});
            const bounds = await page.evaluate(() => {
                const rect = document.querySelector('#display').getBoundingClientRect();
                const canvas = document.querySelector('canvas').getBoundingClientRect();
                return [rect.width, rect.height, rect.x, rect.y, canvas.height];
            });
            const visible = height * 0.83;
            const expected = [visible * 4 / 3, visible, (width - visible * 4 / 3) / 2,
                (height - visible) / 2, visible * 240 / 224];
            bounds.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1));
            await capture(page, height === 720 ? 'stage-1' : 'stage-1-1080');
        }
        await menu(page, ['Escape']);
        await page.waitForFunction(() => document.querySelector('#display').dataset.menu === '1');
        const menuBounds=await page.locator('#display').boundingBox();
        assert.ok(Math.abs(menuBounds.width / menuBounds.height - 16 / 9) < .01);
        await capture(page, 'system-menu');
        await menu(page, ['Home','ArrowDown','ArrowDown','Enter','Home','Enter','Home','ArrowRight','ArrowRight','Enter']);
        await capture(page, 'screen-settings');
        await checkScreenMode(page, '2');
        for(const mode of [0,1,2,3]) {
            await menu(page, ['Home', ...Array(mode).fill('ArrowRight'), 'Enter']);
            await checkScreenMode(page, String(mode));
            await checkShooterPreview(page,mode);
        }
        await menu(page,['ArrowLeft']);
        await checkScreenMode(page,'3');
        await checkShooterPreview(page,3);
        await menu(page,['Enter']);
        await checkScreenMode(page,'2');
        // Enable both filters, then exercise their actual effect on the saved
        // viewport after the menu is closed.
        await menu(page, ['End','ArrowUp','Enter','ArrowUp','Enter']);
        assert.equal(await page.evaluate(() => Module.canvas.dataset.picture), '3');
        assert.equal(await page.evaluate(() => Module.canvas.style.imageRendering), 'auto');
        await menu(page, ['Home','Enter','End','Enter']);
        await menu(page, ['Home','ArrowRight','ArrowRight','Enter']);
        await capture(page, 'controller-settings');
        await menu(page, ['Home','Enter','Home','ArrowLeft','Enter']);
        // Detect the cyan collection title on black and measure its upward travel.
        await page.evaluate(() => {
            const sample=document.createElement('canvas');
            sample.width=320; sample.height=180;
            const ctx=sample.getContext('2d', {willReadFrequently:true});
            window.creditTitleY=()=>{
                ctx.drawImage(Module.canvas,0,0,320,180);
                const p=ctx.getImageData(0,0,320,180).data;
                const corner=(320*4+20)*4;
                if (p[corner]+p[corner+1]+p[corner+2]>15) return -1;
                let sum=0,hits=0;
                for(let y=4;y<178;y++) for(let x=66;x<254;x++) {
                    const i=(320*y+x)*4;
                    if(p[i+1]>48 && p[i+2]>p[i+1] && p[i+1]-p[i]>35) { sum+=y; ++hits; }
                }
                return hits>20 ? sum/hits : -1;
            };
        });
        await page.waitForFunction(() => creditTitleY()>55 && creditTitleY()<122);
        const titleY=await page.evaluate(() => creditTitleY());
        await page.waitForFunction(y => creditTitleY()>0 && creditTitleY()<y-12,titleY);
        await capture(page, 'staff-credits');
        // Once fast scrolling reaches the producer card there are four seconds
        // to see it before the menu returns to the Settings page.
        await page.keyboard.down('ArrowDown');
        try {
            await page.waitForTimeout(21100);
            await capture(page,'staff-credits-middle');
            await page.waitForTimeout(37500);
            await page.waitForFunction(() => {
                const canvas=document.createElement('canvas');
                canvas.width=320; canvas.height=180;
                const ctx=canvas.getContext('2d'); ctx.drawImage(Module.canvas,0,0,320,180);
                const p=ctx.getImageData(0,0,320,180).data;
                let minX=320,maxX=-1,minY=180,maxY=-1;
                for(let y=0;y<180;++y) for(let x=0;x<320;++x) {
                    const i=(320*y+x)*4;
                    if(p[i]<95 || p[i+1]<95 || p[i+2]<95) continue;
                    minX=Math.min(minX,x); maxX=Math.max(maxX,x);
                    minY=Math.min(minY,y); maxY=Math.max(maxY,y);
                }
                return minY>=86 && minY<=91 && maxY<=95 && minX<100 && maxX>220;
            },null,{polling:80,timeout:90000});
            await capture(page,'staff-credits-final');
        } finally { await page.keyboard.up('ArrowDown'); }
        await page.waitForFunction(() => creditTitleY()<0 && (() => {
            const c=document.createElement('canvas'); c.width=80; c.height=45;
            const ctx=c.getContext('2d'); ctx.drawImage(Module.canvas,0,0,80,45);
            const pixels=ctx.getImageData(8,15,64,11).data;
            return pixels.some((v,i)=>i%4===2 && v>65 && v>pixels[i-2]+40);
        })(),null,{timeout:12000});
        await menu(page, ['Home','ArrowDown','Enter','Home','ArrowLeft','Enter']);
        await capture(page, 'wallpaper-settings');
        const previewRanges = await page.evaluate(() => {
            const canvas=Module.canvas, copy=document.createElement('canvas');
            copy.width=canvas.width; copy.height=canvas.height;
            const ctx=copy.getContext('2d'); ctx.drawImage(canvas,0,0);
            return [0,1,2,3].map(i => {
                const x=canvas.width*(.183+i*.173), y=canvas.height*.518;
                const data=ctx.getImageData(x,y,canvas.width*.110,canvas.height*.096).data;
                let range=0;
                for (let j=0;j<data.length;j+=4)
                    range=Math.max(range,Math.max(data[j],data[j+1],data[j+2])-Math.min(data[j],data[j+1],data[j+2]));
                return range;
            });
        });
        assert.ok(previewRanges.slice(0,3).every(n => n>20) && previewRanges[3]<5,
            'wallpaper previews should show the three images and solid black: '+previewRanges);
        await page.waitForFunction(() => document.querySelector('main').dataset.wallpaper === '3');
        await menu(page, ['Home','Enter','End','Enter','End','Enter','Backspace']);
        await checkScreenMode(page, '0');
        await page.waitForFunction(() => document.querySelector('#display').dataset.menu === '0');
        const scanRows = await page.evaluate(() => {
            const screen=Module.canvas, sample=document.createElement('canvas');
            sample.width=screen.width; sample.height=screen.height;
            const context=sample.getContext('2d');
            context.drawImage(screen,0,0);
            const pixels=context.getImageData(3,Math.floor(screen.height/3),1,24).data;
            return [...pixels].filter((_, i) => i%4 === 0);
        });
        assert.ok(scanRows.includes(98) && scanRows.includes(73), 'scan lines should alternate in the grey border: '+scanRows);
        await press(page, 'j', () => window.seenShot1);
        // A rewind must restore a previous position and accept a new direction.
        const origin = await page.evaluate(() => gameState.y1);
        await page.keyboard.down('w');
        try {
            await page.waitForFunction(y => gameState.y1 <= y - 24, origin);
        } finally {
            await page.keyboard.up('w');
        }
        const advanced = await page.evaluate(() => gameState.y1);
        for (let steps = 0; steps < 3; steps++) {
            await menu(page, ['r'], 'Game rewound.');
            if (await page.evaluate(y => gameState.y1 > y, advanced)) break;
        }
        const restored = await page.evaluate(() => gameState.y1);
        assert.ok(restored > advanced, 'rewind did not restore an earlier position');
        await page.keyboard.down('s');
        try {
            await page.waitForFunction(y => gameState.y1 > y || gameState.y1 === 192, restored);
        } finally {
            await page.keyboard.up('s');
        }

        await page.setViewportSize({width: 1280, height: 720});
        await start(page);
        await press(page, 's', () => gameState.selection === 1);
        await press(page, 's', () => gameState.selection === 2);
        await press(page, 'Enter', () => gameState.mode === 2);
        await press(page, 'd', () => gameState.cursor === 1);
        await press(page, 'j', () => gameState.design === 26);
        await press(page, 'Enter', () => gameState.mode === 0);
        await press(page, 's', () => gameState.selection === 1);
        await press(page, 'Enter', () => gameState.mode === 6);
        await press(page, 'Enter', () => gameState.mode === 1 && gameState.players === 2 && gameState.board === 26);
        await press(page, 'w', () => gameState.y1 < 188);
        await press(page, 'ArrowUp', () => gameState.y2 < 188);
        await press(page, 'n', () => window.seenShot2);
        await press(page, 'Enter', () => gameState.mode === 5);
        const stopped = await page.evaluate(() => gameState.y2);
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(300);
        await page.keyboard.up('ArrowUp');
        assert.equal(await page.evaluate(() => gameState.y2), stopped);
        await press(page, 'Enter', () => gameState.mode === 1);
        // Save the paused co-op match, then restore it from a new document.
        await press(page, 'Enter', () => gameState.mode === 5);
        const saved = await page.evaluate(() => [gameState.stage, gameState.y1, gameState.y2]);
        await menu(page, ['Escape','Home','Enter','Home','Enter']);
        await capture(page, 'save-confirmation');
        const slotPath=await page.evaluate(() => Module.arguments[Module.arguments.indexOf('-state_directory')+1]+'/nes/1.sta');
        assert.equal(await page.evaluate(p => FS.analyzePath(p).exists,slotPath),false);
        await menu(page, ['Enter'], 'Game saved.');
        const firstSlot = await slotDigest(page, 1);
        // Cancel an overwrite of slot one, then create slot four with the same controls.
        await menu(page, ['Escape','Home','Enter','Home','Enter','Backspace',
            'Home','ArrowLeft','Enter','Enter'], 'Game saved.');
        assert.equal(await slotDigest(page, 1), firstSlot, 'cancel changed slot one');
        const fourthSlot = await slotDigest(page, 4);
        await menu(page, ['Escape','Home','Enter','Home','Delete'], 'Slot lock saved.');
        // The custom battlefield is mostly empty. Check the actual compositor
        // output for the NES background and bright game pixels in its preview.
        await renderFrames(page, 3);
        const viewport = await page.locator('canvas').boundingBox();
        const clip = {x: viewport.x + viewport.width * .134, y: viewport.y + viewport.height * .408,
            width: viewport.width * .147, height: viewport.height * .23};
        const preview = await page.screenshot({clip});
        const counts = await page.evaluate(async encoded => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + encoded;
            await image.decode();
            const sample = document.createElement('canvas');
            sample.width = 64;
            sample.height = 48;
            const ctx = sample.getContext('2d');
            ctx.drawImage(image, 0, 0, 64, 48);
            const pixels = ctx.getImageData(0, 0, 64, 48).data;
            let black = 0, bright = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                const max = Math.max(pixels[i], pixels[i+1], pixels[i+2]);
                if (max < 4) black++;
                if (max > 85) bright++;
            }
            return {black, bright};
        }, preview.toString('base64'));
        await capture(page, 'protected-slot');
        assert.ok(counts.black > 200 && counts.bright > 12, 'Missing on-screen save thumbnail: '+JSON.stringify(counts));
        // Selecting a protected slot must leave the cursor here. Move to slot four
        // and cancel its overwrite to verify the protected state was untouched.
        await menu(page, ['Enter','ArrowLeft','Enter','End','Enter']);
        await start(page);
        assert.equal(await slotDigest(page, 4), fourthSlot, 'slot four changed after reload');
        assert.equal(await page.evaluate(() => Module.canvas.dataset.picture), '3', 'picture settings did not survive reload');
        const lockPath = await page.evaluate(() => Module.arguments[Module.arguments.indexOf('-state_directory')+1]+'/nes/1.sta.lock');
        assert.equal(await page.evaluate(p => FS.analyzePath(p).exists, lockPath), true, 'slot lock did not survive reload');
        assert.equal(await slotDigest(page, 1), firstSlot, 'locked save changed after reload');
        await menu(page, ['Escape','Home','ArrowDown','Enter','Home','Enter'], 'Game loaded.');
        await page.waitForFunction(() => gameState.mode === 5 && gameState.players === 2);
        assert.deepEqual(await page.evaluate(() => [gameState.stage, gameState.y1, gameState.y2]), saved);
        await menu(page, ['Escape','Home','Enter','Home','Delete'], 'Slot lock saved.');
        assert.equal(await page.evaluate(p => FS.analyzePath(p).exists, lockPath), false, 'slot remained locked');
        await menu(page, ['Home','Enter','Home','Enter'], 'Game saved.');
        await press(page, 'Enter', () => gameState.mode === 1);
        await page.keyboard.down('ArrowDown');
        try {
            await page.waitForFunction(y => gameState.y2 > y, saved[2]);
        } finally { await page.keyboard.up('ArrowDown'); }
        await menu(page,['Escape','End','Enter','Enter']);
        await page.waitForFunction(() => gameState.mode===0 && !gameState.titleScroll && !window.menuActive);
        assert.deepEqual(errors, []);
        console.log(engine.name() + ' passed 720p/1080p viewport, solo, stage selection, Construction, co-op, shooting, pause, rewind and persistent save/load');
        if (engine === chromium && suite !== 'controls') {
            await verifyScenarios(page, 'attract');
            await verifyScenarios(page, 'opening', 1);
            await verifyScenarios(page, 'opening', 2);
            await verifyCombat(page);
            for (const name of ['solo','coop','base','lives']) await verifyScenarios(page, 'ending', name === 'coop' ? 2 : 1, name);
            for (const name of ['solo','coop']) await verifyScenarios(page, 'campaign', name === 'coop' ? 2 : 1, name);
            await verifyScenarios(page, 'game');
            await verifyScenarios(page, 'audio');
        }
    } finally {
        await browser.close();
    }
}

(async () => {
    if (!url) throw new Error('Serve the packaged site and pass its URL');
    const requested = process.argv[4];
    const suite = process.argv[5];
    if (suite && suite !== 'controls' && (requested !== 'chromium' || !['attract', 'opening', 'combat', 'ending', 'campaign', 'game', 'audio'].includes(suite))) {
        throw new Error('Use controls for either browser, or attract, opening, combat, ending, campaign, game or audio for Chromium');
    }
    for (const engine of [chromium, webkit]) {
        if (!requested || engine.name() === requested) await verify(engine, suite);
    }
    if (requested && !['chromium', 'webkit'].includes(requested)) throw new Error('Unknown browser ' + requested);
})().catch(error => {console.error(error); process.exitCode = 1;});
