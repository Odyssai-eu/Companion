#!/usr/bin/env node
/**
 * companion-local — run tool calls from Companion on your local machine.
 *
 * Usage:
 *   node companion-local/index.mjs \
 *     --url https://nemo.thecomp.ai \
 *     --token hms_your_agents_token
 *
 * Or set env vars:
 *   COMPANION_URL=https://nemo.thecomp.ai
 *   COMPANION_TOKEN=hms_...
 *   node companion-local/index.mjs
 *
 * What it does:
 *   - Connects to Companion via SSE (/api/local-agent/events)
 *   - Listens for tool execution requests (bash, fs_read, fs_write, etc.)
 *   - Executes them locally on this machine
 *   - Returns results to Companion (/api/local-agent/result)
 *
 * Tools executed locally:
 *   bash      — shell commands (no sandbox, runs as you)
 *   fs_read   — read local files
 *   fs_write  — write local files
 *   fs_list   — list local directories
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const COMPANION_URL = (flag("url") ?? process.env.COMPANION_URL ?? "").replace(/\/$/, "");
const TOKEN = flag("token") ?? process.env.COMPANION_TOKEN ?? "";

if (!COMPANION_URL || !TOKEN) {
  console.error("Usage: node companion-local/index.mjs --url <URL> --token <hms_...>");
  console.error("  or set COMPANION_URL + COMPANION_TOKEN env vars");
  process.exit(1);
}

// Working directory for bash commands (defaults to current dir)
const BASH_CWD = flag("cwd") ?? process.env.COMPANION_LOCAL_CWD ?? process.cwd();
const BASH_TIMEOUT = parseInt(flag("timeout") ?? process.env.COMPANION_LOCAL_TIMEOUT ?? "30000", 10);

// ── Tool executors ────────────────────────────────────────────────────────

async function executeTool(tool, toolArgs) {
  switch (tool) {
    case "bash": {
      const command = String(toolArgs.command ?? "").trim();
      if (!command) return { ok: false, error: "missing 'command'" };
      try {
        const { stdout, stderr } = await execFileAsync("/bin/bash", ["-c", command], {
          cwd: BASH_CWD,
          timeout: BASH_TIMEOUT,
          maxBuffer: 2_000_000,
          env: { ...process.env },
        });
        return { ok: true, data: { stdout: stdout.slice(0, 16000), stderr: stderr.slice(0, 4000), command } };
      } catch (e) {
        return { ok: false, error: [e.stderr?.slice(0, 500), e.message].filter(Boolean).join("\n") };
      }
    }

    case "fs_read": {
      const path = resolve(String(toolArgs.path ?? ""));
      try {
        const content = await readFile(path, "utf8");
        return { ok: true, data: { path, content, sizeBytes: Buffer.byteLength(content) } };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case "fs_write": {
      const path = resolve(String(toolArgs.path ?? ""));
      const content = String(toolArgs.content ?? "");
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
        return { ok: true, data: { path, sizeBytes: Buffer.byteLength(content) } };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case "fs_list": {
      const { readdir, stat } = await import("node:fs/promises");
      const prefix = String(toolArgs.prefix ?? ".");
      const dir = resolve(prefix);
      try {
        const entries = await readdir(dir);
        const files = await Promise.all(
          entries.map(async (name) => {
            const full = `${dir}/${name}`;
            try {
              const s = await stat(full);
              return { path: `${prefix}/${name}`, sizeBytes: s.size, isDir: s.isDirectory() };
            } catch {
              return { path: `${prefix}/${name}`, sizeBytes: 0, isDir: false };
            }
          })
        );
        return { ok: true, data: files };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    default:
      return { ok: false, error: `unknown tool: ${tool}` };
  }
}

// ── SSE connection ────────────────────────────────────────────────────────

async function sendResult(requestId, result) {
  try {
    await fetch(`${COMPANION_URL}/api/local-agent/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ requestId, ...result }),
    });
  } catch (e) {
    console.error(`[local-agent] failed to send result for ${requestId}:`, e.message);
  }
}

async function connect() {
  const url = `${COMPANION_URL}/api/local-agent/events?token=${encodeURIComponent(TOKEN)}`;
  console.log(`[companion-local] connecting to ${COMPANION_URL} …`);

  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      // Don't set a timeout — SSE stream is long-lived
    });
  } catch (e) {
    console.error("[companion-local] connection failed:", e.message);
    return false;
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[companion-local] ${res.status}: ${body.slice(0, 200)}`);
    return false;
  }

  console.log("[companion-local] connected ✓  waiting for tool calls…");
  console.log(`  bash cwd : ${BASH_CWD}`);

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6).trim();
        } else if (line === "") {
          // End of event
          if (eventType === "connected") {
            console.log("[companion-local] handshake OK");
          } else if (eventType === "tool_execute" && eventData) {
            const { requestId, tool, args } = JSON.parse(eventData);
            console.log(`[companion-local] → ${tool}(${JSON.stringify(args).slice(0, 80)})`);
            const result = await executeTool(tool, args);
            const status = result.ok ? "✓" : "✗";
            console.log(`[companion-local] ${status} ${requestId}`);
            await sendResult(requestId, result);
          } else if (eventType === "ping") {
            // keep-alive, ignore
          }
          eventType = "";
          eventData = "";
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("[companion-local] stream error:", e.message);
    }
  }

  console.log("[companion-local] disconnected");
  return true;
}

// ── Main loop with reconnect ──────────────────────────────────────────────

async function main() {
  let delay = 2000;
  while (true) {
    await connect();
    console.log(`[companion-local] reconnecting in ${delay / 1000}s…`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 30_000); // exponential backoff, max 30s
  }
}

main().catch(console.error);
