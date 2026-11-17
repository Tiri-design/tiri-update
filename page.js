// page.js — the update page (index.html). A file of its own, so the page's
// Content-Security-Policy can forbid inline scripts.
import { ESPLoader, Transport } from "./vendor/esptool-js-0.6.1/bundle.js";
import { readLatest, loadRelease, readHubVersion, flashHub, browserSupport } from "./flash.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const log = (t) => { logEl.textContent += t.replace(/\r/g, "") + (t.endsWith("\n") ? "" : "\n"); logEl.scrollTop = 1e9; };
const note = (el, cls, html) => { el.className = "note " + cls; el.innerHTML = html; };
const ESPRESSIF_VID = 0x303a;

let release = null, port = null;

// Web Serial: Chrome, Edge, Firefox 151+ on a computer (flash.js browserSupport)
const NOBROWSER = {
  safari: "<b>Safari can't update the hub from this page</b>: it has no access to USB devices. " +
          "Use <a href=\"#file-h\">Update with a file</a> below, or open this page in Chrome, Edge or Firefox.",
  firefox_old: "<b>Firefox can update the hub from version 151 on.</b> This one is version %v: " +
               "update it (menu, Help, About Firefox), or use <a href=\"#file-h\">Update with a file</a> below.",
  firefox_off: "<b>This Firefox has USB access turned off</b> (often a company setting). " +
               "Use <a href=\"#file-h\">Update with a file</a> below, or Chrome or Edge.",
  phone: "<b>Phones can't update the hub from this page.</b> Use a computer: Chrome, Edge or Firefox, " +
         "or any browser with <a href=\"#file-h\">Update with a file</a> below.",
  other: "<b>This browser can't talk to USB devices.</b> Use Chrome, Edge or Firefox (151 or newer) on a computer, " +
         "or <a href=\"#file-h\">Update with a file</a> below.",
};
const support = browserSupport(navigator.userAgent, "serial" in navigator);
if (!support.serial) {
  $("nobrowser").innerHTML = NOBROWSER[support.why].replace("%v", String(support.version || ""));
  $("nobrowser").classList.remove("hidden");
  $("steps").classList.add("hidden");
} else if (support.firefox) {
  $("ffnote").classList.remove("hidden");
}

// The version line, then the release itself. No latest.json = nothing
// published yet: say so plainly, nothing to connect to.
const noUpdate = (cls, html) => {
  note($("cnote"), cls, html);
  $("cnote").classList.remove("hidden");
  $("connect").disabled = true;
};
let latest = null;
try { latest = await readLatest("./firmware/"); } catch (e) { log("latest.json: " + e.message); }
if (latest) {
  $("latest").textContent = "Latest: " + latest.version;
  $("latest").classList.remove("none");
  try {
    release = await loadRelease("./firmware/");
    $("vnew").textContent = "v" + release.version + (release.built ? "  (" + release.built + ")" : "");
    if (release.file) {                                    // v0.29: Update with a file
      $("fileget").href = release.file.href;
      $("fileget").setAttribute("download", release.file.name);
      $("fileget").textContent = "Download " + release.file.name + " (" + (release.file.size / 1048576).toFixed(1) + " MB)";
      $("fileget").classList.remove("hidden");
      $("filenone").classList.add("hidden");
    }
    log("Release " + release.version + ": " + release.files.map((f) => f.path + "@0x" + f.address.toString(16)).join(", "));
  } catch (e) {
    log("Release: " + e.message);
    noUpdate("bad", "The update files on this page can't be used right now (" + e.message + "). Please try again later.");
  }
} else {
  $("latest").textContent = "No update available yet";
  log("No release published (no firmware/latest.json).");
  noUpdate("care", "<b>No update available yet.</b> Your hub keeps working as it is. Check this page again later.");
}

async function findPortAgain(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ports = (await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === ESPRESSIF_VID);
    if (ports.length) return ports[0];
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function showVersion(v) {
  $("verinfo").classList.remove("hidden");
  if (!v) $("vnow").textContent = "no answer (it may be stuck: updating usually fixes that)";
  else if (v.old) $("vnow").textContent = "older than v0.18";
  else $("vnow").textContent = "v" + v.version + (v.built ? "  (" + v.built + ")" : "");
  // v0.29: the hub's clock is set to this computer's time while connected
  if (v && v.clock) { $("clockinfo").classList.remove("hidden"); $("vclock").textContent = v.clock.slice(0, 16) + " (this computer's time)"; }
}

$("connect").onclick = async () => {
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch (e) { return; }                                  // the user closed the list
  $("connect").disabled = true;
  $("connect").textContent = "Reading the hub…";
  let v = null;
  try { v = await readHubVersion(port, { setClock: true }); } catch (e) { log("version: " + e.message); }
  log("Hub says: " + JSON.stringify(v));
  showVersion(v);
  $("connect").textContent = "Connected";
  $("s2").classList.add("done");
  $("cnote").classList.remove("hidden");
  if (v && v.version === release.version) note($("cnote"), "good", "The hub already has this version. You can update anyway.");
  else note($("cnote"), "care", "Ready to update.");
  $("update").disabled = false;
};

$("update").onclick = async () => {
  $("update").disabled = true;
  $("prog").classList.remove("hidden");
  $("unote").classList.add("hidden");
  const set = (f) => { $("barfill").style.width = Math.round(f * 100) + "%"; $("progtext").textContent = "Writing… " + Math.round(f * 100) + " %"; };
  try {
    await flashHub(port, release, { ESPLoader, Transport }, { log, progress: set });
    $("progtext").textContent = "Restarting the hub…";
    await new Promise((r) => setTimeout(r, 2500));
    const again = (await findPortAgain(10000)) || port;
    let v = null;
    try { v = await readHubVersion(again, { timeoutMs: 12000, setClock: true }); } catch (e) { log("version after: " + e.message); }
    log("Hub says after the update: " + JSON.stringify(v));
    showVersion(v);
    $("progtext").textContent = "Done";
    $("s3").classList.add("done");
    if (v && v.version === release.version) note($("unote"), "good", "<b>Done.</b> The hub runs v" + v.version + ". You can unplug it.");
    else note($("unote"), "care", "<b>Written.</b> The hub didn't confirm its version yet. If its screen is back, all is well; otherwise unplug it, plug it in again and repeat.");
  } catch (e) {
    log("ERROR: " + (e && e.message ? e.message : e));
    note($("unote"), "bad", "<b>The update didn't finish.</b> Nothing is lost: unplug the hub, plug it in again and repeat from step 2. (" +
         (e && e.message ? e.message : e) + ")");
    $("update").disabled = false;
  }
  $("unote").classList.remove("hidden");
};
