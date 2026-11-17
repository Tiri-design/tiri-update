// flash.js — what the update page does, without the page: load a release,
// check it, write it to the hub, read the hub's version. index.html calls
// these; test/flash.test.mjs runs them against a fake hub in Node.
//
// The rule that matters: ONLY the four release parts are written, never an
// erase. The flash area from 0x9000 to 0xE000 (NVS: kit key, tag slots,
// names, settings, touch calibration) is never touched, so an update keeps
// everything the parent set up.

export const NVS_START = 0x9000;
export const NVS_END = 0xe000;
export const ALLOWED = { "bootloader.bin": 0x0, "partitions.bin": 0x8000, "boot_app0.bin": 0xe000, "hub.bin": 0x10000 };

// ---------------------------------------------------------------- MD5
// (esptool-js uses it to verify each part after writing)
export function md5(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const n = bytes.length, total = ((n + 8) >> 6) + 1, w = new Uint32Array(total * 16);
  for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
  w[n >> 2] |= 0x80 << ((n % 4) * 8);
  w[total * 16 - 2] = (n * 8) >>> 0;
  w[total * 16 - 1] = Math.floor(n / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < w.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + K[i] + w[o + g]) >>> 0, s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let hex = "";
  for (const v of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) hex += ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  return hex;
}

// ---------------------------------------------------------------- release
// Checks a manifest: the right parts at the right places, none inside NVS.
export function checkManifest(m) {
  if (!m || !Array.isArray(m.parts)) throw new Error("manifest has no parts");
  if (m.chip !== "ESP32-S3") throw new Error("manifest is not for the ESP32-S3 hub");
  if (m.flash_size !== "16MB") throw new Error("manifest is not for a 16 MB hub");
  const names = m.parts.map((p) => p.path).sort().join(",");
  if (names !== Object.keys(ALLOWED).sort().join(",")) throw new Error("unexpected parts: " + names);
  for (const p of m.parts) {
    if (ALLOWED[p.path] !== p.offset) throw new Error(p.path + " at a wrong place (0x" + p.offset.toString(16) + ")");
    const end = p.offset + Math.ceil(p.size / 4096) * 4096;     // the chip erases whole 4 KB sectors before writing
    if (p.offset < NVS_END && end > NVS_START) throw new Error(p.path + " would overwrite the settings area");
  }
  // v0.29: the update file (hubs v0.29+ take it as the USB drive TIRI-HUB, any browser). Optional.
  if (m.file !== undefined) {
    if (!m.file || m.file.path !== "tiri-hub-" + m.version + ".uf2" || !Number.isInteger(m.file.size) || m.file.size <= 0 ||
        m.file.size % 512) throw new Error("the update file entry is wrong");
  }
  return true;
}

// firmware/latest.json: {version, manifest}. null when there is none yet
// (404: nothing published); any other failure throws.
export async function readLatest(base, fetchFn = fetch) {
  const r = await fetchFn(base + "latest.json", { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("could not load latest.json (" + r.status + ")");
  const latest = await r.json();
  if (!latest || typeof latest.version !== "string" || typeof latest.manifest !== "string")
    throw new Error("latest.json is incomplete");
  return latest;
}

// The newest release, checked and loaded. null: no release published yet.
export async function loadRelease(base, fetchFn = fetch) {
  const latest = await readLatest(base, fetchFn);
  if (!latest) return null;
  const mpath = base + latest.manifest;
  const mr = await fetchFn(mpath, { cache: "no-store" });
  if (!mr.ok) throw new Error("could not load " + latest.manifest);
  const m = await mr.json();
  checkManifest(m);
  const dir = mpath.slice(0, mpath.lastIndexOf("/") + 1);
  const files = [];
  for (const p of m.parts) {
    const r = await fetchFn(dir + p.path, { cache: "no-store" });
    if (!r.ok) throw new Error("could not load " + p.path);
    const data = new Uint8Array(await r.arrayBuffer());
    if (data.length !== p.size || md5(data) !== p.md5) throw new Error(p.path + " is damaged (size or checksum)");
    files.push({ path: p.path, address: p.offset, data });
  }
  files.sort((a, b) => a.address - b.address);
  // v0.29: the update file is only linked (downloaded by the person), not loaded here
  const file = m.file ? { href: dir + m.file.path, name: m.file.path, size: m.file.size } : null;
  return { version: m.version, built: m.built || "", files, file };
}

// ---------------------------------------------------------------- browser
// What this browser can do. Web Serial: Chrome and Edge (since 89), Firefox on
// a computer since 151 (May 2026; it asks once to allow the site, a small
// "site permission add-on"). Safari has no Web Serial (Apple opposes it).
// ua = navigator.userAgent, hasSerial = "serial" in navigator.
//   {serial: true, firefox}            this page can update the hub here
//   {serial: false, why: "safari" | "firefox_old" | "firefox_off" | "phone" | "other", version?}
export function browserSupport(ua, hasSerial) {
  const ff = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua);
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return { serial: false, why: "phone" };
  if (hasSerial) return { serial: true, firefox: !!ff };
  if (ff && Number(ff[1]) < 151) return { serial: false, why: "firefox_old", version: Number(ff[1]) };
  if (ff) return { serial: false, why: "firefox_off" };          // 151+ without it: turned off (company policy?)
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return { serial: false, why: "safari" };
  return { serial: false, why: "other" };
}

// ---------------------------------------------------------------- hub version
// "FW,0.18-revC,Oct 30 2026 07:00:00" (serial 'v', hub v0.18+)
export function parseVersionLine(line) {
  const m = /^FW,([^,]+),(.*)$/.exec(line.trim());
  return m ? { version: m[1], built: m[2] } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "t 2026-11-04 07:05:00": the hub's serial clock command, in the computer's local time
export function clockCommand(d) {
  const p = (n) => String(n).padStart(2, "0");
  return "t " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// Asks the hub for its version over plain serial. Copes with the hub
// restarting when the port opens (it answers ~3 s later): resends 'v'.
// Returns {version, built}; {version: null, old: true} for a hub from before
// v0.18 (it answers "? for help"); null if nothing answers (e.g. crash loop).
// With setClock (v0.29): a hub that answered its version also gets the
// computer's time ('t'); result.clock is the time the hub reports back, or
// false if it has no clock chip / didn't confirm.
export async function readHubVersion(port, { timeoutMs = 9000, now = () => Date.now(), setClock = false, clockNow = () => new Date() } = {}) {
  await port.open({ baudRate: 115200 });
  const enc = new TextEncoder(), dec = new TextDecoder();
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  let buf = "", result = null;
  const end = now() + timeoutMs;
  let nextSend = 0;
  // reads lines until test(line) gives something other than undefined, or the time is up
  const readUntil = async (until, test, resend) => {
    while (now() < until) {
      if (resend && now() >= nextSend) { await writer.write(enc.encode(resend() + "\n")); nextSend = now() + 1500; }
      const r = await Promise.race([reader.read(), sleep(250).then(() => null)]);
      if (r === null) continue;
      if (r.done) return undefined;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        const x = test(line);
        if (x !== undefined) return x;
      }
    }
    return undefined;
  };
  try {
    result = (await readUntil(end, (line) => {
      const v = parseVersionLine(line);
      if (v) return v;
      if (line.includes("? for help")) return { version: null, built: "", old: true };   // a hub before v0.18
      return undefined;
    }, () => "v")) || null;
    if (result && result.version && setClock) {
      nextSend = 0;
      const c = await readUntil(now() + 4000, (line) => {
        const m = /^# rtc set: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(line.trim());
        if (m) return m[1];
        if (line.includes("# use: t ") || line.includes("USE_RTC is 0")) return false;   // no clock chip
        return undefined;
      }, () => clockCommand(clockNow()));
      result.clock = c === undefined ? false : c;
    }
  } finally {
    try { await reader.cancel(); } catch (e) {}
    reader.releaseLock();
    writer.releaseLock();
    await port.close();
  }
  return result;
}

// ---------------------------------------------------------------- flashing
// Writes the release. 'lib' = { ESPLoader, Transport } from esptool-js.
// log(text) and progress(fraction 0..1) report to the page.
export async function flashHub(port, release, lib, { log = () => {}, progress = () => {} } = {}) {
  const transport = new lib.Transport(port, false);
  const terminal = { clean() {}, writeLine: (t) => log(t), write: (t) => log(t) };
  const loader = new lib.ESPLoader({ transport, baudrate: 921600, terminal, debugLogging: false });
  try {
    const chip = await loader.main();                 // resets the hub into its bootloader (no BOOT button)
    log("Connected: " + chip);
    if (!/ESP32-S3/.test(chip)) throw new Error("This is not a Tiri hub (found " + chip + ")");
    const size = await loader.detectFlashSize();
    if (size !== "16MB") throw new Error("Unexpected flash size " + size + " (the hub has 16MB)");
    const total = release.files.reduce((s, f) => s + f.data.length, 0);
    const before = [];
    let acc = 0;
    for (const f of release.files) { before.push(acc); acc += f.data.length; }
    await loader.writeFlash({
      fileArray: release.files.map((f) => ({ data: f.data, address: f.address })),
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false,                                  // never: it would wipe the kit key and settings
      compress: true,
      reportProgress: (i, written, len) => progress((before[i] + (written / len) * release.files[i].data.length) / total),
      calculateMD5Hash: (img) => md5(img),
    });
    progress(1);
    log("Written and verified. Restarting the hub.");
    await loader.after("hard_reset");
  } finally {
    try { await transport.disconnect(); } catch (e) {}
  }
}
