// The WASI host. Runs in a dedicated worker and never runs wasm itself, so it is always free to
// answer. Every wasm thread (the main one and each thread-spawn) runs in its own thread worker and
// forwards its file-system calls here; the host reads and writes the shared wasm memory directly
// at the pointers the call carries, then wakes the caller through its control word.
//
// Messages from the page:
//   {t:'init', wasm: ArrayBuffer, files: [[path, ArrayBuffer], ...]}   load the module and the data folder
//   {t:'put', path, data: ArrayBuffer}                                  add or replace a file
//   {t:'run', args: [...], env: {...}, id}                              run `ym` with these arguments
//   {t:'get', path, id}                                                 read a file back
//   {t:'rm', prefix}                                                    delete files under a folder
// Messages to the page: {t:'ready'}, {t:'log', text}, {t:'exit', id, code, ms}, {t:'file', id, data}
import { memoryLimits } from './memlimits.js';

const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58 };
const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4 };

// ---- the in-memory file system ----------------------------------------------------------------
const nodes = new Map(); // path -> {dir:true, mtime} | {dir:false, data:Uint8Array, size, mtime}
let inoNext = 1; const inos = new Map();
const ino = (p) => { if (!inos.has(p)) inos.set(p, inoNext++); return inos.get(p); };
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

function norm(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
function parent(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function mkdirs(p) {
  p = norm(p);
  if (nodes.has(p)) return;
  if (p !== '/') mkdirs(parent(p));
  nodes.set(p, { dir: true, mtime: nowNs() });
}
function putFile(p, bytes) {
  p = norm(p); mkdirs(parent(p));
  const data = new Uint8Array(bytes);
  nodes.set(p, { dir: false, data, size: data.length, mtime: nowNs() });
}
function children(dir) {
  const pre = dir === '/' ? '/' : dir + '/';
  const names = [];
  for (const k of nodes.keys()) if (k !== dir && k.startsWith(pre) && !k.slice(pre.length).includes('/')) names.push(k.slice(pre.length));
  return names.sort();
}
mkdirs('/');

// ---- fd table ---------------------------------------------------------------------------------
const fds = new Map();
fds.set(0, { kind: 'stdin' }); fds.set(1, { kind: 'out', buf: '' }); fds.set(2, { kind: 'out', buf: '' });
fds.set(3, { kind: 'dir', path: '/', preopen: '/' });
let fdNext = 4;

// ---- memory access ----------------------------------------------------------------------------
let memory = null;
const dv = () => new DataView(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const readStr = (ptr, len) => new TextDecoder().decode(u8().slice(ptr, ptr + len));
const resolve = (dirfd, ptr, len) => {
  const d = fds.get(dirfd);
  if (!d || d.kind !== 'dir') return null;
  return norm(d.path + '/' + readStr(ptr, len));
};
function writeFilestat(ptr, path, node) {
  const v = dv();
  v.setBigUint64(ptr, 1n, true);
  v.setBigUint64(ptr + 8, BigInt(ino(path)), true);
  v.setUint8(ptr + 16, node.dir ? FT.DIR : FT.FILE);
  v.setBigUint64(ptr + 24, 1n, true);
  v.setBigUint64(ptr + 32, BigInt(node.dir ? 0 : node.size), true);
  v.setBigUint64(ptr + 40, node.mtime, true);
  v.setBigUint64(ptr + 48, node.mtime, true);
  v.setBigUint64(ptr + 56, node.mtime, true);
}
function flushOut(fd, force) {
  const f = fds.get(fd);
  let i;
  while ((i = f.buf.indexOf('\n')) >= 0) { postMessage({ t: 'log', fd, text: f.buf.slice(0, i) }); f.buf = f.buf.slice(i + 1); }
  if (force && f.buf) { postMessage({ t: 'log', fd, text: f.buf }); f.buf = ''; }
}

// ---- the WASI calls threads forward here ------------------------------------------------------
const sys = {
  fd_close(fd) { if (!fds.has(fd)) return E.BADF; if (fd > 3) fds.delete(fd); return E.SUCCESS; },
  fd_fdstat_get(fd, ptr) {
    const f = fds.get(fd); if (!f) return E.BADF;
    const v = dv();
    v.setUint8(ptr, f.kind === 'dir' ? FT.DIR : f.kind === 'file' ? FT.FILE : FT.CHAR);
    v.setUint16(ptr + 2, f.append ? 1 : 0, true);
    v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
    v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
    return E.SUCCESS;
  },
  fd_filestat_get(fd, ptr) {
    const f = fds.get(fd); if (!f) return E.BADF;
    if (f.kind === 'file' || f.kind === 'dir') { const n = nodes.get(f.path); if (!n) return E.NOENT; writeFilestat(ptr, f.path, n); return E.SUCCESS; }
    new Uint8Array(memory.buffer, ptr, 64).fill(0); dv().setUint8(ptr + 16, FT.CHAR); return E.SUCCESS;
  },
  fd_prestat_get(fd, ptr) {
    const f = fds.get(fd); if (!f || !f.preopen) return E.BADF;
    const v = dv(); v.setUint8(ptr, 0); v.setUint32(ptr + 4, new TextEncoder().encode(f.preopen).length, true); return E.SUCCESS;
  },
  fd_prestat_dir_name(fd, ptr, len) {
    const f = fds.get(fd); if (!f || !f.preopen) return E.BADF;
    u8().set(new TextEncoder().encode(f.preopen).subarray(0, len), ptr); return E.SUCCESS;
  },
  fd_read(fd, iovs, n, nreadPtr) {
    const f = fds.get(fd); if (!f) return E.BADF;
    const v = dv(); let total = 0;
    if (f.kind === 'file') {
      const node = nodes.get(f.path); if (!node) return E.BADF;
      const mem = u8();
      for (let i = 0; i < n; i++) {
        const buf = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        const take = Math.max(0, Math.min(len, node.size - f.pos));
        if (take > 0) mem.set(node.data.subarray(f.pos, f.pos + take), buf);
        f.pos += take; total += take;
        if (take < len) break;
      }
    } else if (f.kind === 'dir') return E.ISDIR;
    v.setUint32(nreadPtr, total, true); return E.SUCCESS;
  },
  fd_write(fd, iovs, n, nwrittenPtr) {
    const f = fds.get(fd); if (!f) return E.BADF;
    const v = dv(); const mem = u8(); let total = 0;
    for (let i = 0; i < n; i++) {
      const buf = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
      if (f.kind === 'out') { f.buf += new TextDecoder().decode(mem.slice(buf, buf + len)); }
      else if (f.kind === 'file') {
        const node = nodes.get(f.path); if (!node) return E.BADF;
        if (f.append) f.pos = node.size;
        const end = f.pos + len;
        if (end > node.data.length) { const grown = new Uint8Array(Math.max(end, node.data.length * 2, 65536)); grown.set(node.data.subarray(0, node.size)); node.data = grown; }
        node.data.set(mem.subarray(buf, buf + len), f.pos);
        f.pos = end; if (end > node.size) node.size = end; node.mtime = nowNs();
      } else return E.BADF;
      total += len;
    }
    if (f.kind === 'out') flushOut(fd, false);
    v.setUint32(nwrittenPtr, total, true); return E.SUCCESS;
  },
  fd_seek(fd, offset, whence, outPtr) {
    const f = fds.get(fd); if (!f) return E.BADF;
    if (f.kind !== 'file') return E.INVAL;
    const node = nodes.get(f.path);
    const base = whence === 0 ? 0 : whence === 1 ? f.pos : node.size;
    const next = base + Number(offset); if (next < 0) return E.INVAL;
    f.pos = next; dv().setBigUint64(outPtr, BigInt(next), true); return E.SUCCESS;
  },
  fd_sync() { return E.SUCCESS; },
  fd_readdir(fd, buf, bufLen, cookie, usedPtr) {
    const f = fds.get(fd); if (!f || f.kind !== 'dir') return E.BADF;
    const names = ['.', '..', ...children(f.path)];
    const mem = u8(); const v = dv(); let used = 0;
    for (let i = Number(cookie); i < names.length; i++) {
      const name = names[i]; const enc = new TextEncoder().encode(name);
      const full = name === '.' ? f.path : name === '..' ? parent(f.path) : norm(f.path + '/' + name);
      const node = nodes.get(full) || { dir: true };
      const head = new Uint8Array(24); const hv = new DataView(head.buffer);
      hv.setBigUint64(0, BigInt(i + 1), true); hv.setBigUint64(8, BigInt(ino(full)), true);
      hv.setUint32(16, enc.length, true); hv.setUint8(20, node.dir ? FT.DIR : FT.FILE);
      const entry = new Uint8Array(24 + enc.length); entry.set(head); entry.set(enc, 24);
      const room = bufLen - used; const take = Math.min(room, entry.length);
      mem.set(entry.subarray(0, take), buf + used); used += take;
      if (take < entry.length) break;
    }
    v.setUint32(usedPtr, used, true); return E.SUCCESS;
  },
  path_create_directory(fd, ptr, len) {
    const p = resolve(fd, ptr, len); if (p === null) return E.BADF;
    if (nodes.has(p)) return E.EXIST;
    if (!nodes.get(parent(p))?.dir) return E.NOENT;
    nodes.set(p, { dir: true, mtime: nowNs() }); return E.SUCCESS;
  },
  path_filestat_get(fd, _flags, ptr, len, out) {
    const p = resolve(fd, ptr, len); if (p === null) return E.BADF;
    const n = nodes.get(p); if (!n) return E.NOENT;
    writeFilestat(out, p, n); return E.SUCCESS;
  },
  path_open(dirfd, _dirflags, ptr, len, oflags, _rb, _ri, fdflags, outPtr) {
    const p = resolve(dirfd, ptr, len); if (p === null) return E.BADF;
    let n = nodes.get(p);
    const CREAT = 1, DIRECTORY = 2, EXCL = 4, TRUNC = 8;
    if (n && (oflags & EXCL) && (oflags & CREAT)) return E.EXIST;
    if (!n) {
      if (!(oflags & CREAT)) return E.NOENT;
      if (!nodes.get(parent(p))?.dir) return E.NOENT;
      n = { dir: false, data: new Uint8Array(0), size: 0, mtime: nowNs() }; nodes.set(p, n);
    }
    if ((oflags & DIRECTORY) && !n.dir) return E.NOTDIR;
    if (!n.dir && (oflags & TRUNC)) { n.size = 0; n.mtime = nowNs(); }
    const fd = fdNext++;
    fds.set(fd, n.dir ? { kind: 'dir', path: p } : { kind: 'file', path: p, pos: 0, append: !!(fdflags & 1) });
    dv().setUint32(outPtr, fd, true); return E.SUCCESS;
  },
  path_readlink() { return E.INVAL; },
  path_rename(fd, op, ol, fd2, np, nl) {
    const a = resolve(fd, op, ol), b = resolve(fd2, np, nl); if (a === null || b === null) return E.BADF;
    const n = nodes.get(a); if (!n) return E.NOENT;
    if (n.dir) {
      for (const [k, v] of [...nodes]) if (k === a || k.startsWith(a + '/')) { nodes.delete(k); nodes.set(b + k.slice(a.length), v); }
    } else { nodes.delete(a); nodes.set(b, n); }
    for (const f of fds.values()) if (f.path === a) f.path = b;
    return E.SUCCESS;
  },
  path_unlink_file(fd, ptr, len) {
    const p = resolve(fd, ptr, len); if (p === null) return E.BADF;
    const n = nodes.get(p); if (!n) return E.NOENT; if (n.dir) return E.ISDIR;
    nodes.delete(p); return E.SUCCESS;
  },
  path_remove_directory(fd, ptr, len) {
    const p = resolve(fd, ptr, len); if (p === null) return E.BADF;
    const n = nodes.get(p); if (!n) return E.NOENT; if (!n.dir) return E.NOTDIR;
    if (children(p).length) return E.NOTEMPTY;
    nodes.delete(p); return E.SUCCESS;
  },
};

// ---- threads ----------------------------------------------------------------------------------
let module = null;
let run = null; // {id, args, env, workers:Set, start, done}
let tidNext = 1;

function startThread(tid, arg) {
  const w = new Worker(new URL('./thread.js', import.meta.url), { type: 'module' });
  const ctl = new Int32Array(new SharedArrayBuffer(16));
  const own = run;
  run.workers.add(w);
  w.onmessage = (ev) => {
    // A message from a thread of a run that has ended (cancelled, or a late one in flight) must
    // not touch the run that replaced it.
    if (run !== own) { w.terminate(); return; }
    const m = ev.data;
    if (m.t === 'sys') {
      let r;
      try {
        if (m.fn === 'thread_spawn') r = spawn(m.args[0]);
        else if (m.fn === 'proc_exit') { finish(m.args[0]); return; }
        else r = sys[m.fn] ? sys[m.fn](...m.args) : E.NOSYS;
      } catch (e) { postMessage({ t: 'log', fd: 2, text: `host: ${m.fn} failed: ${e}` }); r = E.INVAL; }
      Atomics.store(ctl, 1, r); Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0);
    } else if (m.t === 'done') {
      run?.workers.delete(w); w.terminate();
      if (tid === 0) finish(0);
    } else if (m.t === 'trap') {
      postMessage({ t: 'log', fd: 2, text: `thread ${tid}: ${m.error}` });
      finish(m.code ?? 134);
    }
  };
  w.postMessage({ t: 'start', module, memory, tid, arg, ctl, args: run.args, env: run.env });
}
function spawn(arg) { const tid = tidNext++; startThread(tid, arg); return tid; }
function finish(code) {
  if (!run || run.done) return;
  run.done = true;
  flushOut(1, true); flushOut(2, true);
  for (const w of run.workers) w.terminate();
  postMessage({ t: 'exit', id: run.id, code, ms: Math.round(performance.now() - run.start), maxPages: run_maxPages, peakPages: memory ? memory.buffer.byteLength / 65536 : 0 });
  run = null;
}

let limits = null;
let run_maxPages = 0;
let starting = false;
onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === 'init') {
    limits = memoryLimits(m.wasm);
    module = await WebAssembly.compile(m.wasm);
    for (const [p, data] of m.files) putFile(p, data);
    postMessage({ t: 'ready', maxPages: limits.max });
  } else if (m.t === 'cancel') { finish(-2); }
  else if (m.t === 'put') putFile(m.path, m.data);
  else if (m.t === 'rm') { for (const k of [...nodes.keys()]) if (k.startsWith(m.prefix)) nodes.delete(k); }
  else if (m.t === 'get') {
    const n = nodes.get(norm(m.path));
    const data = n && !n.dir ? n.data.slice(0, n.size) : null;
    postMessage({ t: 'file', id: m.id, data, names: n && n.dir ? children(norm(m.path)) : null }, data ? [data.buffer] : []);
  } else if (m.t === 'run') {
    if (run || starting || !limits) { postMessage({ t: 'exit', id: m.id, code: -1, ms: 0, busy: !!run }); return; }
    // A fresh memory each run. It can't be reused: wasm memory never shrinks, and the allocator in
    // `ym` takes the current size as the start of its heap, so a reused memory fills up run by run.
    // Each new memory reserves its whole maximum, so a run asks only for what it needs (`maxPages`:
    // previews need far less than a full-size export), and if iOS has not yet given back the last
    // run's reservation, waits a moment and tries again.
    memory = null; starting = true;
    const top = Math.min(limits.max, m.maxPages || limits.max);
    for (let attempt = 0; attempt < 4 && !memory; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
      for (const max of [top, 49152, 32768, 24576, 16384, 12288, 8192, 6144, 4096]) {
        if (max > top || max < limits.min) continue;
        try { memory = new WebAssembly.Memory({ initial: limits.min, maximum: max, shared: true }); run_maxPages = max; break; } catch { /* try smaller */ }
      }
    }
    starting = false;
    if (!memory) { postMessage({ t: 'exit', id: m.id, code: -3, ms: 0 }); return; }
    run = { id: m.id, args: m.args, env: m.env, workers: new Set(), start: performance.now(), done: false };
    tidNext = 1; fdNext = 4;
    for (const k of [...fds.keys()]) if (k > 3) fds.delete(k);
    startThread(0, 0);
  }
};
