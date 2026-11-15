# Yellowmoon for iPhone (web app)

The `ym` command-line tool, built for WebAssembly with threads, running in Safari. Nothing is
uploaded: the raw file, the colour data and the rendering all stay on the phone.

## Use it

1. Open the GitHub Pages address of this repository in Safari on the iPhone.
2. Share → Add to Home Screen. It then opens full screen and works offline.
3. Tap **Open** and pick an ARW from the Files app. (The Photos picker usually hands over a JPEG
   copy instead of the raw. Save the raw to Files first, from the camera app or AirDrop.)
4. Change the look, light, colour and lens. Each change renders a quick preview.
5. Tap **Export**. When the share sheet opens, tap **Save Image** to put it in Photos.

## How it works

- `ym.wasm` is `ym` built for `wasm32-wasip1-threads` (`web/build.sh`). Its shared memory may grow
  to 4 GiB (`.cargo/config.toml`), enough for a 33 MP A7C II file on the CPU path.
- `src/host.js` is a small WASI host in a worker: it keeps the files in memory and answers the
  file-system calls of every wasm thread. `src/thread.js` runs one wasm thread per worker.
- Previews run `ym render` with `YELLOWMOON_DRAFT=4`: `ym_raw::draft` averages each 4x4 block of
  same-colour photosites, so the pipeline runs on a sixteenth of the pixels. Exports run the same
  command at full size, so they match the desktop app's exports for the same options.
- Each run gets a fresh wasm memory (the allocator can't start over in a used one), sized to the
  job: previews may grow to 768 MiB (a 33 MP draft peaks near 260 MiB), exports to the most the
  phone will give (a 33 MP full-size export peaks near 1.3 GiB). Asking for 4 GiB on every preview
  is what made iOS refuse after a few changes.
- A preview renders twice: a quick pass without noise reduction and output sharpening (most of the
  time), then the full one. The preview is sized to the area it is shown in.
- `sw.js` adds the cross-origin isolation headers threads need (GitHub Pages cannot send them) and
  caches the app for offline use.

## Limits

- CPU only: no Metal or WebGPU path yet. A full-size export takes about a minute.
- The neural demosaic and the Object, Depth and Apple Auto features are not in this build.
- No looks import yet: the two built-in looks only.
- No colour warp, curves, manual crop or film nodes on the phone: the controls are the `ym render`
  options (auto-crop included), not the `--settings` graph.

## Develop

```
web/build.sh                                  # builds web/dist
python3 web/tools/serve.py web/dist 8124      # serve it (with the isolation headers)
cd web && npm install && node tools/e2e.mjs http://127.0.0.1:8124/ some.ARW /tmp/out
```
