// Yellowmoon on the phone: the `ym` CLI built for WebAssembly, run by a small WASI host in workers.
// Previews are `ym render` with YELLOWMOON_DRAFT=4 (a quarter-size sensor); exports are the same
// command at full size, so what you export is what Yellowmoon on the desktop would export.
import { unpack } from './src/unpack.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

// ---- cross-origin isolation (threads need SharedArrayBuffer) -----------------------------------
async function isolate() {
  if (self.crossOriginIsolated) { sessionStorage.removeItem('ym-reloaded'); return true; }
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!sessionStorage.getItem('ym-reloaded')) { sessionStorage.setItem('ym-reloaded', '1'); location.reload(); return null; }
  return reg && self.crossOriginIsolated;
}

// ---- the engine ---------------------------------------------------------------------------------
const host = new Worker(new URL('./src/host.js', import.meta.url), { type: 'module' });
let nextId = 1;
const waiters = new Map();
const logLines = [];
host.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'log') { logLines.push(m.text); if (logLines.length > 200) logLines.shift(); console.log('[ym]', m.text); }
  else if (m.t === 'ready') waiters.get('ready')?.(m);
  else if (m.t === 'exit' || m.t === 'file') { waiters.get(m.id)?.(m); waiters.delete(m.id); }
};
const request = (msg) => new Promise((res) => { const id = nextId++; waiters.set(id, res); host.postMessage({ ...msg, id }); });

async function fetchWithProgress(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const reader = r.body.getReader(); const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length;
    status(`${label} ${Math.round((got / total) * 100)}%`);
  }
  const out = new Uint8Array(got); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

async function boot() {
  const ok = await isolate();
  if (ok === null) return;
  if (!ok || typeof SharedArrayBuffer === 'undefined') {
    status('This browser blocks the shared memory Yellowmoon needs. Open the page in Safari and try again.');
    return;
  }
  const wasm = await fetchWithProgress('ym.wasm', 'Loading engine');
  const pack = await fetchWithProgress('data.pack', 'Loading colour data');
  const ready = new Promise((res) => waiters.set('ready', res));
  host.postMessage({ t: 'init', wasm, files: unpack(pack) }, [wasm]);
  await ready;
  status('Ready');
}

// ---- settings → `ym render` options --------------------------------------------------------------
const chip = (group) => $(group).querySelector('[aria-checked=true]').dataset.v;
const num = (id) => Number($(id).value);
function options() {
  const o = ['--look', chip('look')];
  if (num('intensity') !== 100) o.push('--intensity', String(num('intensity')));
  if (num('exposure') !== 0) o.push('--exposure-offset', num('exposure').toFixed(1));
  for (const k of ['contrast', 'highlights', 'shadows', 'white', 'black', 'saturation']) if (num(k) !== 0) o.push(`--${k}`, String(num(k)));
  const light = chip('light');
  if (light === 'custom') o.push('--wb', `${num('kelvin')},${num('tint')}`);
  else if (light !== 'auto') o.push('--light', light);
  const lens = chip('lens');
  if (lens) o.push('--lens', lens, '--flares', String(num('flares')), '--edges', String(num('edges')), '--anamorphic', String(num('anamorphic')));
  return o;
}

// ---- running ym ---------------------------------------------------------------------------------
let photo = null; // {name, path}
let running = null; // 'preview' | 'export'
let pending = false;
let previewUrl = null;

const env = (draft) => ({
  YELLOWMOON_DATA: '/data', HOME: '/home', TMPDIR: '/tmp',
  RAYON_NUM_THREADS: String(Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4))),
  ...(draft ? { YELLOWMOON_DRAFT: String(draft) } : {}),
});

async function runYm(args, draft) {
  host.postMessage({ t: 'rm', prefix: '/out/' });
  const t0 = performance.now();
  const ex = await request({ t: 'run', args: ['ym', 'render', '--cpu', ...args, photo.path, '--out', '/out', '--overwrite'], env: env(draft) });
  if (ex.code !== 0) return { error: ex.code, ms: ex.ms, maxPages: ex.maxPages };
  const dir = await request({ t: 'get', path: '/out' });
  const name = (dir.names || [])[0];
  if (!name) return { error: 'nofile' };
  const file = await request({ t: 'get', path: `/out/${name}` });
  return { data: file.data, name, ms: Math.round(performance.now() - t0) };
}

function explain(r) {
  if (r.error === -2) return null; // cancelled for a newer preview
  if (r.error === -3) return 'This phone would not give Yellowmoon enough memory. Close other apps and try again.';
  const last = logLines.slice(-4).join(' ').trim();
  return last ? `It didn't work: ${last}` : `It didn't work (code ${r.error}).`;
}

async function preview() {
  if (!photo) return;
  if (running === 'export') { pending = true; return; }
  if (running === 'preview') { pending = true; host.postMessage({ t: 'cancel' }); return; }
  running = 'preview'; pending = false; $('busy').hidden = false; status('Rendering preview…');
  const edge = Math.min(2048, Math.round(Math.max(screen.width, screen.height) * (devicePixelRatio || 2)));
  const r = await runYm([...options(), '--format', 'jpeg', '--quality', '85', '--long-edge', String(edge), '--output-sharpening', '60', '--name', 'preview'], 4);
  running = null;
  if (r.data) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([r.data], { type: 'image/jpeg' }));
    $('preview').src = previewUrl; $('preview').hidden = false; $('empty').hidden = true;
    status(`Preview in ${(r.ms / 1000).toFixed(1)} s`);
  } else { const why = explain(r); if (why) status(why); }
  if (pending) { pending = false; preview(); } else $('busy').hidden = true;
}

async function exportPhoto() {
  if (!photo || running === 'export') return;
  if (running === 'preview') { host.postMessage({ t: 'cancel' }); await new Promise((r) => setTimeout(r, 50)); running = null; }
  running = 'export'; $('busy').hidden = false; $('export').disabled = true;
  const fmt = chip('format'); const size = chip('size');
  status('Exporting at full quality. This takes a minute or two…');
  const opts = [...options(), '--format', fmt];
  if (fmt === 'jpeg') opts.push('--quality', '95'); else opts.push('--bits', '16');
  if (size) opts.push('--long-edge', size);
  opts.push('--name', '{name}_{look}');
  const r = await runYm(opts, 0);
  running = null; $('busy').hidden = true; $('export').disabled = false;
  if (!r.data) { status(explain(r) || 'Export stopped.'); return; }
  const type = fmt === 'jpeg' ? 'image/jpeg' : 'image/tiff';
  const file = new File([r.data], r.name.replace(/^photo/, photo.base), { type });
  status(`Exported in ${(r.ms / 1000).toFixed(0)} s`);
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* the person closed the sheet */ }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  if (pending) { pending = false; preview(); }
}

// ---- controls -----------------------------------------------------------------------------------
const defaults = new Map();
function showValue(input) {
  const out = input.parentElement.querySelector('output');
  if (!out) return;
  const v = Number(input.value);
  out.textContent = (input.step && input.step.includes('.') ? v.toFixed(1) : String(v)) + (input.dataset.unit || '');
}
for (const input of document.querySelectorAll('input[type=range]')) {
  defaults.set(input.id, input.value); showValue(input);
  input.addEventListener('input', () => showValue(input));
  input.addEventListener('change', () => preview());
  // Double-tap a slider's label to put it back.
  input.parentElement.addEventListener('dblclick', (e) => { if (e.target !== input) { input.value = defaults.get(input.id); showValue(input); preview(); } });
}
for (const group of document.querySelectorAll('.chips')) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of group.children) x.setAttribute('aria-checked', String(x === b));
    if (group.id === 'light') $('wb-custom').hidden = b.dataset.v !== 'custom';
    if (group.id === 'lens') $('lens-amounts').hidden = !b.dataset.v;
    if (group.id !== 'format' && group.id !== 'size') preview();
  });
}
$('reset').addEventListener('click', () => {
  for (const [id, v] of defaults) { $(id).value = v; showValue($(id)); }
  for (const group of document.querySelectorAll('.chips')) if (group.id !== 'format' && group.id !== 'size') {
    [...group.children].forEach((x, i) => x.setAttribute('aria-checked', String(i === 0)));
  }
  $('wb-custom').hidden = true; $('lens-amounts').hidden = true;
  preview();
});
$('export').addEventListener('click', exportPhoto);
$('file').addEventListener('change', async () => {
  const f = $('file').files[0]; if (!f) return;
  if (!/\.arw$/i.test(f.name)) { status('That isn\'t an ARW file. Pick the raw from the Files app.'); return; }
  status('Reading the file…');
  const data = await f.arrayBuffer();
  host.postMessage({ t: 'rm', prefix: '/in/' });
  host.postMessage({ t: 'put', path: '/in/photo.ARW', data }, [data]);
  photo = { path: '/in/photo.ARW', base: f.name.replace(/\.arw$/i, '') };
  $('controls').hidden = false; $('reset').disabled = false; $('export').disabled = false;
  $('file').value = '';
  preview();
});

boot().catch((e) => status(`Yellowmoon couldn't start: ${e.message}`));
