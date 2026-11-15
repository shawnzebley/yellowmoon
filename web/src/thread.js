// One wasm thread. tid 0 runs `_start`; every other tid runs `wasi_thread_start(tid, arg)`.
// Clocks, randomness, sleeps and the argument list are answered here; file-system calls and
// thread-spawn go to the host worker, and this thread waits on its control word for the answer.
let ctl, memory;
const enc = new TextEncoder();

function forward(fn, args) {
  Atomics.store(ctl, 0, 0);
  postMessage({ t: 'sys', fn, args });
  Atomics.wait(ctl, 0, 0);
  return Atomics.load(ctl, 1);
}
const fwd = (fn) => (...args) => forward(fn, args);

function strings(list) {
  const items = list.map((s) => enc.encode(s + '\0'));
  return { items, size: items.reduce((a, b) => a + b.length, 0) };
}

class Exit extends Error {}

onmessage = (ev) => {
  const m = ev.data;
  if (m.t !== 'start') return;
  ctl = m.ctl; memory = m.memory;
  const dv = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  const argv = strings(m.args);
  const envv = strings(Object.entries(m.env).map(([k, v]) => `${k}=${v}`));
  const putList = (list, ptrs, buf) => {
    const v = dv(), mem = u8(); let at = buf;
    list.items.forEach((s, i) => { v.setUint32(ptrs + i * 4, at, true); mem.set(s, at); at += s.length; });
    return 0;
  };
  const sleepWord = new Int32Array(new SharedArrayBuffer(4));
  const wasi = {
    args_sizes_get(c, s) { const v = dv(); v.setUint32(c, argv.items.length, true); v.setUint32(s, argv.size, true); return 0; },
    args_get(p, b) { return putList(argv, p, b); },
    environ_sizes_get(c, s) { const v = dv(); v.setUint32(c, envv.items.length, true); v.setUint32(s, envv.size, true); return 0; },
    environ_get(p, b) { return putList(envv, p, b); },
    clock_time_get(id, _prec, out) {
      const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
      dv().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true); return 0;
    },
    random_get(buf, len) {
      const tmp = new Uint8Array(len);
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, Math.min(len, i + 65536)));
      u8().set(tmp, buf); return 0;
    },
    sched_yield() { return 0; },
    poll_oneoff(inp, out, n, neventsPtr) {
      // Only clock subscriptions (thread::sleep and timed waits) are expected; wait for the shortest.
      const v = dv(); let shortest = Infinity;
      for (let i = 0; i < n; i++) {
        const s = inp + i * 48;
        if (v.getUint8(s + 8) === 0) {
          let t = Number(v.getBigUint64(s + 24, true)) / 1e6;
          if (v.getUint16(s + 40, true) & 1) t -= performance.timeOrigin + performance.now(); // absolute
          shortest = Math.min(shortest, Math.max(0, t));
        }
      }
      if (shortest !== Infinity && shortest > 0) Atomics.wait(sleepWord, 0, 0, shortest);
      for (let i = 0; i < n; i++) {
        const s = inp + i * 48, e = out + i * 32;
        v.setBigUint64(e, v.getBigUint64(s, true), true);
        v.setUint16(e + 8, v.getUint8(s + 8) === 0 ? 0 : 52, true);
        v.setUint8(e + 10, v.getUint8(s + 8));
      }
      v.setUint32(neventsPtr, n, true); return 0;
    },
    proc_exit(code) { forward('proc_exit', [code]); throw new Exit(String(code)); },
  };
  for (const name of ['fd_close', 'fd_fdstat_get', 'fd_filestat_get', 'fd_prestat_get', 'fd_prestat_dir_name', 'fd_read',
    'fd_readdir', 'fd_seek', 'fd_sync', 'fd_write', 'path_create_directory', 'path_filestat_get', 'path_open',
    'path_readlink', 'path_rename', 'path_unlink_file', 'path_remove_directory']) wasi[name] = fwd(name);
  // Anything else the module imports and this file does not know answers "not supported".
  const imports = { env: { memory }, wasi_snapshot_preview1: wasi, wasi: { 'thread-spawn': (arg) => forward('thread_spawn', [arg]) } };
  for (const imp of WebAssembly.Module.imports(m.module)) {
    if (imp.kind === 'function' && !imports[imp.module]?.[imp.name]) {
      imports[imp.module] ??= {};
      imports[imp.module][imp.name] = () => 52;
    }
  }
  try {
    const inst = new WebAssembly.Instance(m.module, imports);
    if (m.tid === 0) inst.exports._start();
    else inst.exports.wasi_thread_start(m.tid, m.arg);
    postMessage({ t: 'done' });
  } catch (e) {
    if (e instanceof Exit) return;
    postMessage({ t: 'trap', error: String(e && e.stack || e) });
  }
};
