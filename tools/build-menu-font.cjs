// Convert the regular UI face from the pinned MAME documentation into its native bitmap format.
// node tools/build-menu-font.cjs path/to/lato-normal.woff runtime/menu-regular.bdc
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const {chromium} = createRequire(path.resolve(__dirname, '../web/package.json'))('@playwright/test');

async function build(source, destination) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const glyphs = await page.evaluate(async data => {
            const face = new FontFace('Menu Regular', 'url(data:font/woff;base64,' + data + ')');
            document.fonts.add(await face.load());
            const canvas = document.createElement('canvas');
            canvas.width = 80;
            canvas.height = 64;
            const ctx = canvas.getContext('2d', {willReadFrequently:true});
            ctx.font = '40px "Menu Regular"';
            const result = [];
            for (const code of [...Array.from({length:95}, (_, i) => 32+i),
                                ...Array.from({length:96}, (_, i) => 160+i), 0x152,0x153,0x160,0x161,0x17d,0x17e,0x2019,0xfffd]) {
                const char = String.fromCodePoint(code);
                ctx.clearRect(0, 0, 80, 64);
                ctx.fillText(char, 8, 45);
                const rgba = ctx.getImageData(0, 0, 80, 64).data;
                let left=80, top=64, right=-1, bottom=-1;
                for (let y=0; y<64; ++y) for (let x=0; x<80; ++x) {
                    if (rgba[(80*y+x)*4+3]<100) continue;
                    left=Math.min(left,x); top=Math.min(top,y);
                    right=Math.max(right,x); bottom=Math.max(bottom,y);
                }
                const bits=[];
                for (let y=top; y<=bottom; ++y) for (let x=left; x<=right; ++x)
                    bits.push(rgba[(80*y+x)*4+3]>=100);
                result.push({code,advance:Math.round(ctx.measureText(char).width),
                    left:bits.length ? left-8 : 0, lower:bits.length ? 44-bottom : 0,
                    width:Math.max(0,right-left+1),height:Math.max(0,bottom-top+1),bits});
            }
            return result;
        }, fs.readFileSync(source).toString('base64'));
        const header=Buffer.alloc(32), table=Buffer.alloc(16*glyphs.length);
        header.write('bdcfnt'); header[6]=1;
        header.writeUInt32BE(glyphs.length,20); header.writeUInt16BE(44,24);
        header.writeInt16BE(-9,26); header.writeUInt32BE(0xfffd,28);
        const bitmaps=glyphs.map((g,i) => {
            const at=i*16;
            table.writeUInt32BE(g.code,at); table.writeUInt16BE(g.advance,at+4);
            table.writeInt16BE(g.left,at+8); table.writeInt16BE(g.lower,at+10);
            table.writeUInt16BE(g.width,at+12); table.writeUInt16BE(g.height,at+14);
            const bytes=Buffer.alloc(Math.ceil(g.bits.length/8));
            g.bits.forEach((ink,j) => {if (ink) bytes[j>>3] |= 128>>(j%8);});
            return bytes;
        });
        fs.writeFileSync(destination, Buffer.concat([header,table,...bitmaps]));
    } finally { await browser.close(); }
}
build(...process.argv.slice(2)).catch(error => {console.error(error); process.exitCode=1;});
