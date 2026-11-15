// Packs a folder into one file: u32 header length, JSON [[path, offset, size], ...], then the bytes.
// Usage: node pack.mjs <folder> <prefix-in-wasm-fs> <out>
import fs from 'node:fs'; import path from 'node:path';
const [dir, prefix, out] = process.argv.slice(2);
const list = []; const chunks = []; let off = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) { const b = fs.readFileSync(p); list.push([prefix + '/' + path.relative(dir, p).split(path.sep).join('/'), off, b.length]); chunks.push(b); off += b.length; }
  }
})(dir);
const head = Buffer.from(JSON.stringify(list)); const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
fs.writeFileSync(out, Buffer.concat([len, head, ...chunks]));
console.log(`${list.length} files, ${(off / 1e6).toFixed(1)} MB -> ${out}`);
