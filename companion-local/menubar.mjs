#!/usr/bin/env node
/**
 * companion-local menubar widget.
 *
 * Usage:
 *   node companion-local/menubar.mjs \
 *     --url https://nemo.thecomp.ai \
 *     --token hms_... \
 *     --cwd ~/projects
 *
 * Shows an icon in the macOS menubar:
 *   ● when connected, ○ when stopped, ◌ when connecting
 *
 * Menu:
 *   ● Connected · nemo.thecomp.ai    (status, disabled)
 *   ↳ bash(git log)                  (last action, disabled)
 *   ─────────────────────────────
 *   📁 /Users/you/projects           (cwd, disabled)
 *   ─────────────────────────────
 *   Stop                             (or Start)
 *   ─────────────────────────────
 *   Quit
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const SysTray = require("systray").default ?? require("systray");
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const COMPANION_URL = (flag("url") ?? process.env.COMPANION_URL ?? "").replace(/\/$/, "");
const TOKEN = flag("token") ?? process.env.COMPANION_TOKEN ?? "";
const CWD = flag("cwd") ?? process.env.COMPANION_LOCAL_CWD ?? process.cwd();

if (!COMPANION_URL || !TOKEN) {
  console.error("Usage: node menubar.mjs --url <URL> --token <hms_...> [--cwd <path>]");
  process.exit(1);
}

const SHORT_URL = COMPANION_URL.replace(/^https?:\/\//, "");

// ── Icons (tiny 1-bit PNG, base64 encoded) ────────────────────────────────
// macOS menubar icons should be ~22x22px template images (black on transparent).
// We use Unicode as title text since embedding proper PNGs is complex.
// systray uses the icon field as base64 PNG — use a minimal transparent 1x1 PNG.
const TRANSPARENT_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ── State ─────────────────────────────────────────────────────────────────

let status = "stopped"; // stopped | starting | connected | error
let lastAction = "";
let daemonProcess = null;

// Seq IDs for menu items
const SEQ = {
  STATUS: 0,
  LAST_ACTION: 1,
  SEP1: 2,
  CWD: 3,
  SEP2: 4,
  TOGGLE: 5,
  SEP3: 6,
  QUIT: 7,
};

const ICON = { connected: "●", starting: "◌", stopped: "○", error: "⚠" };

function menuTitle() {
  return ICON[status] ?? "○";
}

function statusLine() {
  if (status === "connected") return `${ICON.connected} Connected · ${SHORT_URL}`;
  if (status === "starting") return `${ICON.starting} Connecting…`;
  if (status === "error") return `${ICON.error} Connection error`;
  return `${ICON.stopped} Stopped`;
}

function toggleLabel() {
  return status === "stopped" || status === "error" ? "▶  Start" : "■  Stop";
}

// ── Systray ───────────────────────────────────────────────────────────────

const systray = new SysTray({
  menu: {
    icon: TRANSPARENT_1PX,
    title: menuTitle(),
    tooltip: "companion-local",
    items: [
      { title: statusLine(), tooltip: "", checked: false, enabled: false },
      { title: "—", tooltip: "", checked: false, enabled: false },
      SysTray.separator,
      { title: `  ${CWD}`, tooltip: "Bash working directory", checked: false, enabled: false },
      SysTray.separator,
      { title: toggleLabel(), tooltip: "", checked: false, enabled: true },
      SysTray.separator,
      { title: "Quit", tooltip: "Quit companion-local", checked: false, enabled: true },
    ],
  },
  debug: false,
  copyDir: true,
});

function updateItem(seqId, title, enabled = true) {
  systray.sendAction({
    type: "update-item",
    item: { title, tooltip: "", checked: false, enabled },
    seq_id: seqId,
  });
}

function updateTitle(title) {
  systray.sendAction({ type: "update-menu", item: { title } });
}

function refreshMenu() {
  updateTitle(menuTitle());
  updateItem(SEQ.STATUS, statusLine(), false);
  updateItem(SEQ.LAST_ACTION, lastAction ? `  ↳ ${lastAction}` : "—", false);
  updateItem(SEQ.TOGGLE, toggleLabel(), true);
}

// ── Daemon lifecycle ──────────────────────────────────────────────────────

function startDaemon() {
  if (daemonProcess) return;
  status = "starting";
  refreshMenu();

  const daemonScript = join(__dirname, "index.mjs");
  const argv = [daemonScript, "--url", COMPANION_URL, "--token", TOKEN, "--cwd", CWD];
  daemonProcess = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });

  daemonProcess.stdout.on("data", (d) => {
    const line = d.toString().trim();
    console.log("[daemon]", line);
    if (line.includes("connected ✓")) {
      status = "connected";
      refreshMenu();
    } else if (line.includes("→")) {
      // Tool execution line: "[companion-local] → bash(...)"
      const m = line.match(/→\s+(.+)/);
      if (m) {
        lastAction = m[1].slice(0, 40);
        refreshMenu();
      }
    } else if (line.includes("disconnected") || line.includes("reconnecting")) {
      if (status !== "stopped") {
        status = "starting";
        refreshMenu();
      }
    }
  });

  daemonProcess.stderr.on("data", (d) => console.error("[daemon:err]", d.toString().trim()));

  daemonProcess.on("exit", (code) => {
    if (status !== "stopped") {
      status = "error";
      refreshMenu();
    }
    daemonProcess = null;
  });
}

function stopDaemon() {
  if (!daemonProcess) return;
  daemonProcess.kill("SIGTERM");
  daemonProcess = null;
  status = "stopped";
  lastAction = "";
  refreshMenu();
}

// ── Click handler ─────────────────────────────────────────────────────────

systray.onClick((action) => {
  if (action.seq_id === SEQ.TOGGLE) {
    if (status === "stopped" || status === "error") {
      startDaemon();
    } else {
      stopDaemon();
    }
  } else if (action.seq_id === SEQ.QUIT) {
    stopDaemon();
    systray.kill();
    process.exit(0);
  }
});

systray.onReady(() => {
  console.log("[companion-local] menubar ready — click the icon to start");
  // Auto-start on launch
  startDaemon();
});

systray.onError((err) => {
  console.error("[systray error]", err);
});
