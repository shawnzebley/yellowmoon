// Reads env.memory's limits (pages) from a wasm binary's import section.
export function memoryLimits(bytes) {
  const b = new Uint8Array(bytes); let p = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const str = () => { const n = leb(); const t = new TextDecoder().decode(b.subarray(p, p + n)); p += n; return t; };
  while (p < b.length) {
    const id = b[p++]; const size = leb(); const end = p + size;
    if (id === 2) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const mod = str(), name = str(), kind = b[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; const f = b[p++]; leb(); if (f & 1) leb(); }
        else if (kind === 2) { const f = b[p++]; const min = leb(); const max = (f & 1) ? leb() : undefined; if (mod === 'env' && name === 'memory') return { min, max, shared: !!(f & 2) }; }
        else if (kind === 3) { p += 2; }
      }
    }
    p = end;
  }
  return null;
}
