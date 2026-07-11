import { readFile, writeFile } from 'node:fs/promises';
import pngToIco from 'png-to-ico';

const source = new URL('../src/assets/logo.png', import.meta.url);
const target = new URL('../build/icon.ico', import.meta.url);
const png = await readFile(source);
const ico = await pngToIco(png);
await writeFile(target, ico);
console.log(`[icons] wrote ${target.pathname} (${ico.length} bytes)`);
