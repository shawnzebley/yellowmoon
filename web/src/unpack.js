// Reads the pack made by tools/pack.mjs into [[path, ArrayBuffer], ...].
export function unpack(buf) {
  const len = new DataView(buf).getUint32(0, true);
  const list = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  const base = 4 + len;
  return list.map(([p, off, size]) => [p, buf.slice(base + off, base + off + size)]);
}
