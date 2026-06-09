#!/usr/bin/env python3
"""Hermes ACP-over-TCP gateway (#25, enterprise Hermes on .39).

A containerized client (Companion) can't spawn the host `hermes acp` stdio
binary directly. This tiny service bridges it: per TCP connection it validates a
bearer token (first line `AUTH <token>`), spawns `hermes acp`, then transparently
pumps bytes between the socket and the subprocess stdio. It does NOT parse ACP —
ACP JSON-RPC flows through untouched, so the protocol stays between Companion and
Hermes. One connection = one isolated agent session.

Env: HERMES_GATEWAY_TOKEN (required), HERMES_GATEWAY_HOST (default 0.0.0.0),
     HERMES_GATEWAY_PORT (default 8770), HERMES_BIN (default ~/.local/bin/hermes).
"""
import asyncio
import os
import sys

HERMES = os.environ.get("HERMES_BIN", os.path.expanduser("~/.local/bin/hermes"))
TOKEN = os.environ.get("HERMES_GATEWAY_TOKEN", "")
HOST = os.environ.get("HERMES_GATEWAY_HOST", "0.0.0.0")
PORT = int(os.environ.get("HERMES_GATEWAY_PORT", "8770"))


async def handle(reader, writer):
    peer = writer.get_extra_info("peername")
    try:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
        except asyncio.TimeoutError:
            writer.close()
            return
        parts = line.decode(errors="replace").strip().split(None, 1)
        if len(parts) != 2 or parts[0] != "AUTH" or parts[1] != TOKEN:
            writer.write(b'{"error":"unauthorized"}\n')
            await writer.drain()
            writer.close()
            return
        writer.write(b'{"ok":true}\n')
        await writer.drain()

        proc = await asyncio.create_subprocess_exec(
            HERMES, "acp", "--accept-hooks",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        sys.stderr.write(f"[gateway] session up for {peer} (pid {proc.pid})\n")

        async def sock_to_proc():
            try:
                while True:
                    data = await reader.read(65536)
                    if not data:
                        break
                    proc.stdin.write(data)
                    await proc.stdin.drain()
            except Exception:
                pass
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        async def proc_to_sock():
            try:
                while True:
                    data = await proc.stdout.read(65536)
                    if not data:
                        break
                    writer.write(data)
                    await writer.drain()
            except Exception:
                pass
            finally:
                try:
                    writer.close()
                except Exception:
                    pass

        await asyncio.gather(sock_to_proc(), proc_to_sock())
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        sys.stderr.write(f"[gateway] session closed for {peer}\n")
    except Exception as e:
        sys.stderr.write(f"[gateway] error {peer}: {e}\n")
        try:
            writer.close()
        except Exception:
            pass


async def main():
    if not TOKEN:
        sys.stderr.write("HERMES_GATEWAY_TOKEN not set — refusing to start\n")
        sys.exit(1)
    server = await asyncio.start_server(handle, HOST, PORT)
    sys.stderr.write(f"[gateway] hermes-acp-gateway listening on {HOST}:{PORT}\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
