#!/usr/bin/env python3
"""Smoke-test the ACP gateway: AUTH, then an ACP `initialize` handshake."""
import json
import os
import socket
import sys

TOKEN = os.environ.get("HERMES_GATEWAY_TOKEN", "")
HOST = os.environ.get("GW_HOST", "127.0.0.1")
PORT = int(os.environ.get("GW_PORT", "8770"))

s = socket.create_connection((HOST, PORT), timeout=10)
f = s.makefile("rwb")
f.write(f"AUTH {TOKEN}\n".encode())
f.flush()
print("auth resp:", f.readline().decode().strip())

init = {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {
        "protocolVersion": 1,
        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
    },
}
f.write((json.dumps(init) + "\n").encode())
f.flush()

s.settimeout(50)
try:
    line = f.readline()
    if not line:
        print("initialize resp: <empty / closed>")
        sys.exit(1)
    print("initialize resp:", line.decode(errors="replace")[:500])
except Exception as e:
    print("no response:", e)
    sys.exit(1)
finally:
    s.close()
