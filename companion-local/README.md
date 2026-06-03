# companion-local

Run Companion tool calls locally on your Mac — bash, file read/write, directory listing.

## Setup

1. Get your agents token from Companion:  
   Settings → External agents → **Create token**

2. Run the daemon:
   ```bash
   node companion-local/index.mjs \
     --url https://nemo.thecomp.ai \
     --token hms_your_token_here
   ```
   Or via env vars:
   ```bash
   export COMPANION_URL=https://nemo.thecomp.ai
   export COMPANION_TOKEN=hms_...
   node companion-local/index.mjs
   ```

3. Optional: set the working directory for bash commands:
   ```bash
   node companion-local/index.mjs --url ... --token ... --cwd ~/projects
   ```

## What runs locally

| Tool | Local behaviour |
|---|---|
| `bash` | Shell commands in `--cwd` (default: current dir) |
| `fs_read` | Read local files (absolute or relative to cwd) |
| `fs_write` | Write local files |
| `fs_list` | List local directories |

Other tools (web_search, web_read, web_read_full) always run server-side.

## Auto-start on login (macOS)

Create `~/Library/LaunchAgents/eu.odyssai.companion-local.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist ...>
<plist version="1.0">
<dict>
  <key>Label</key><string>eu.odyssai.companion-local</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/companion-local/index.mjs</string>
    <string>--url</string><string>https://nemo.thecomp.ai</string>
    <string>--token</string><string>hms_your_token</string>
    <string>--cwd</string><string>/Users/you/projects</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/companion-local.log</string>
  <key>StandardErrorPath</key><string>/tmp/companion-local.log</string>
</dict>
</plist>
```
Then: `launchctl load ~/Library/LaunchAgents/eu.odyssai.companion-local.plist`
