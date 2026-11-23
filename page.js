// page.js — the update page (index.html). A file of its own, so the page's
// Content-Security-Policy can forbid inline scripts.
import { ESPLoader, Transport } from "./vendor/esptool-js-0.6.1/bundle.js";
import { readLatest, loadRelease, readHubVersion, flashHub, browserSupport, portBusy } from "./flash.js?v=7aceeff607";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const logEl = $("log");
const log = (t) => { logEl.textContent += t.replace(/\r/g, "") + (t.endsWith("\n") ? "" : "\n"); logEl.scrollTop = 1e9; };
const note = (id, cls, html) => { $(id).className = "note " + cls; $(id).innerHTML = html; show(id); };
const ESPRESSIF_VID = 0x303a;

// What people see: "0.30", not "0.30-revC" (the board revision is for us)
const nice = (v) => String(v).replace(/-rev[A-Z]$/, "");
const MONTHS = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June", Jul: "July",
                 Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" };
const builtMonth = (b) => { const m = /^(\w{3})\s+\d+\s+(\d{4})/.exec(b || ""); return m && MONTHS[m[1]] ? MONTHS[m[1]] + " " + m[2] : ""; };

let release = null, port = null;

// the port is held by another program (flash.js portBusy)
const BUSY = "<b>Something else is using your hub's connection</b>, most often this page open in another tab. " +
  "Close it, unplug the hub, plug it back in and press Connect again.";

// Web Serial: Chrome, Edge, Firefox 151+ on a computer (flash.js browserSupport).
// Not an error: the file way works just as well, and it's right below.
const NOBROWSER = {
  safari: "<b>In Safari, use the file.</b> It works just as well, and <a href=\"#file-h\">the steps are right below</a>.",
  firefox_old: "<b>This Firefox (version %v) can't update from this page.</b> <a href=\"#file-h\">Use the file instead</a>, " +
               "or update Firefox (menu, Help, About Firefox) and come back.",
  firefox_off: "<b>USB access is turned off in this Firefox</b>, often by a company setting. " +
               "<a href=\"#file-h\">Use the file instead</a>. It works just as well.",
  phone: "<b>Updating needs a computer.</b> Open this page on a laptop or desktop. " +
         "There you can update right from the page, or <a href=\"#file-h\">with the file</a>.",
  other: "<b>This browser can't update from this page.</b> <a href=\"#file-h\">Use the file instead</a>, " +
         "or open this page in Chrome or Edge.",
};

// The file way: on browsers that can use USB it's tucked away behind a link
function showFile(scroll) {
  show("route-file");
  show("altlink", false);
  if (scroll) $("file-h").scrollIntoView({ behavior: "smooth", block: "start" });
}
document.querySelectorAll('a[href="#file-h"]').forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showFile(true); }));

const support = browserSupport(navigator.userAgent, "serial" in navigator);
if (!support.serial) {
  $("nobrowser").innerHTML = NOBROWSER[support.why].replace("%v", String(support.version || ""));
  show("nobrowser");
  show("route-web", false);
  $("nobrowser").querySelectorAll('a[href="#file-h"]').forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showFile(true); }));
} else {
  if (location.hash !== "#file-h") show("route-file", false);
  else show("altlink", false);
  if (support.firefox) show("ffhint");
}

// Step states: done (a check), now (the one to do), todo (dimmed), "" (plain)
function stepState(id, st) { $(id).classList.remove("done", "now", "todo"); if (st) $(id).classList.add(st); }

// The version chip, then the release itself. No latest.json = nothing
// published yet: say so plainly, nothing to connect to.
const noUpdate = (cls, html) => { note("cnote", cls, html); $("connect").disabled = true; };
let latest = null;
try { latest = await readLatest("./firmware/"); } catch (e) { log("latest.json: " + e.message); }
if (latest) {
  try {
    release = await loadRelease("./firmware/");
    const month = builtMonth(release.built);
    $("latest").textContent = "Version " + nice(release.version) + (month ? " · " + month : "");
    $("latest").classList.remove("none");
    if ($("whatsnew").dataset.for === release.version) show("whatsnew");   // written for this release only
    if (release.file) {                                    // v0.29: Update with a file
      $("fileget").href = release.file.href;
      $("fileget").setAttribute("download", release.file.name);
      $("fileget").textContent = "Download the update file (" + (release.file.size / 1048576).toFixed(1) + "\u00a0MB)";
      show("fileget");
      show("filenone", false);
    }
    log("Release " + release.version + " (" + release.built + "): " +
        release.files.map((f) => f.path + "@0x" + f.address.toString(16)).join(", "));
  } catch (e) {
    log("Release: " + e.message);
    $("latest").textContent = "Version " + nice(latest.version);
    noUpdate("bad", "The update can't be loaded right now. Please try again a little later.");
  }
} else {
  $("latest").textContent = "No update right now";
  log("No release published (no firmware/latest.json).");
  noUpdate("info", "There's no update to install right now. Your hub keeps working as it is.");
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

// "18:05" from the hub's "2026-11-23 18:05:12" (v0.29+: the page sets its clock while connected)
const clockLine = (v) => {
  const m = v && v.clock ? /\d{2}:\d{2}/.exec(v.clock) : null;
  return m ? " Its clock is set to this computer's time (" + m[0] + ")." : "";
};

$("connect").onclick = async () => {
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch (e) { return; }                                  // the window was closed: nothing to say
  $("connect").disabled = true;
  $("connect").textContent = "Connecting…";
  show("cnote", false);
  let v = null, busy = false;
  try { v = await readHubVersion(port, { setClock: true }); } catch (e) { log("version: " + e.message); busy = portBusy(e); }
  if (busy) {                                              // not connected: say why, offer Connect again
    $("connect").disabled = false;
    $("connect").textContent = "Connect";
    note("cnote", "bad", BUSY);
    return;
  }
  log("Hub says: " + JSON.stringify(v));
  show("unote", false);
  show("calm");
  $("connect").textContent = "Connected";
  stepState("s1", "done"); stepState("s2", "done"); stepState("s3", "now");
  const to = nice(release.version);
  if (!v) note("cnote", "info", "Connected. Your hub didn't tell us its version, which can happen when it's stuck. Updating usually fixes that.");
  else if (v.old) note("cnote", "good", "Connected. Your hub has an older version. Ready to update to " + to + "." + clockLine(v));
  else if (v.version === release.version) note("cnote", "info", "Your hub already has version " + to + ". You can update it again if you like." + clockLine(v));
  else note("cnote", "good", "Connected. Your hub has version " + nice(v.version) + ". Ready to update to " + to + "." + clockLine(v));
  $("update").disabled = false;
  $("s3").scrollIntoView({ behavior: "smooth", block: "center" });
};

$("update").onclick = async () => {
  $("update").disabled = true;
  $("update").textContent = "Updating…";
  show("prog");
  show("unote", false);
  show("calm", false);
  $("progtext").textContent = "Getting ready…";
  const set = (f) => {
    $("barfill").style.width = Math.round(f * 100) + "%";
    $("progtext").textContent = f > 0 ? "Installing… " + Math.round(f * 100) + " %" : "Getting ready…";
  };
  try {
    await flashHub(port, release, { ESPLoader, Transport }, { log, progress: set });
    $("progtext").textContent = "Restarting your hub…";
    await new Promise((r) => setTimeout(r, 2500));
    const again = (await findPortAgain(10000)) || port;
    $("progtext").textContent = "Checking…";
    let v = null;
    try { v = await readHubVersion(again, { timeoutMs: 12000, setClock: true }); } catch (e) { log("version after: " + e.message); }
    log("Hub says after the update: " + JSON.stringify(v));
    show("prog", false);
    show("cnote", false);
    if (v && v.version === release.version) {
      stepState("s3", "done");
      $("update").textContent = "Updated";
      $("finishtext").textContent = "Your hub is on version " + nice(v.version) + ". You can unplug it.";
      show("finish");
      show("altlink", false);
      $("finish").scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      $("update").textContent = "Installed";
      note("unote", "info", "<b>Installed.</b> If the hub's screen is back on, you're all set. " +
           "If it stays dark, unplug it, plug it back in and try once more.");
    }
  } catch (e) {
    log("ERROR: " + (e && e.message ? e.message : e));
    show("prog", false);
    if (portBusy(e)) note("unote", "bad", BUSY + " Nothing was changed.");
    else note("unote", "bad", "<b>The update stopped before it finished.</b> Nothing is lost. " +
              "Unplug the hub, plug it back in and press Connect again.");
    // start over from Connect: the port may be gone after a failed write
    $("update").textContent = "Update now";
    show("cnote", false);
    $("connect").textContent = "Connect";
    $("connect").disabled = false;
    stepState("s2", "now"); stepState("s3", "");          // plain, not dimmed: the message in it must read clearly
  }
};

$("copylog").onclick = async () => {
  try { await navigator.clipboard.writeText(logEl.textContent); $("copylog").textContent = "Copied"; }
  catch (e) { $("copylog").textContent = "Select the text to copy it"; }
  setTimeout(() => { $("copylog").textContent = "Copy"; }, 2500);
};
