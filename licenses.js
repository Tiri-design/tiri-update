// licenses.js — links the current release's relink kit on licenses.html.
import { readLatest } from "./flash.js";

const el = document.getElementById("kit");
try {
  const latest = await readLatest("./firmware/");
  if (latest) {
    const href = "firmware/" + latest.version + "/relink-kit.zip";
    el.textContent = "For the current release (" + latest.version + "): ";
    const a = document.createElement("a");
    a.href = href;
    a.textContent = href;
    el.appendChild(a);
  } else {
    el.textContent = "No release is published yet.";
  }
} catch (e) { /* keep the static text */ }
