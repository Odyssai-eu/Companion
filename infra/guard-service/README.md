# guard-service — Confidential Guard sidecar

FastAPI wrapper around `fastino/gliner2-privacy-filter-PII-multi` (GLiNER2,
mdeberta-v3-base encoder, multilingual incl. FR). Detection only — policy
(warn / force-local) lives in Companion's Confidential Guard add-on.

## API

- `GET /health` → `{status, service, model, loaded}`
- `POST /guard` `{text, threshold?}` → `{sensitive, max_severity, findings[], latency_ms}`

`sensitive` = any high-severity category, or 2+ medium categories.
~40 ms/message on CPU once loaded (first request lazy-loads, ~5 s).

## Install (macOS host, launchd)

```bash
mkdir -p ~/guard-service && cd ~/guard-service
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python gliner2 fastapi "uvicorn[standard]"
# copy server.py here, then pre-download the model once (launchd runs
# with HF_HUB_OFFLINE=1 so it never fetches at boot):
.venv/bin/python -c "from gliner2 import GLiNER2; GLiNER2.from_pretrained('fastino/gliner2-privacy-filter-PII-multi')"
# copy com.odyssai.guard.plist to ~/Library/LaunchAgents/ (adjust paths/port)
launchctl load ~/Library/LaunchAgents/com.odyssai.guard.plist
curl -s http://localhost:8084/health
```

No hardcoded host anywhere in Companion: point the add-on panel
(Settings → Add-ons → Confidential Guard) at `http://<host>:<port>/guard`.
