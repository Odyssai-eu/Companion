# guard-service — Confidential Guard sidecar

Two-stage confidential-content detector. Detection only — policy (warn /
force-local / block) lives in Companion's Confidential Guard add-on.

- **Stage 1 — PII (always on):** `fastino/gliner2-privacy-filter-PII-multi`
  (GLiNER2, mdeberta-v3-base, multilingual incl. FR). Named entities: IBAN,
  email, name, medical condition, `sk-ant-…`, … ~40 ms/msg on CPU.
- **Stage 2 — contextual (opt-in per request):** a DSPy program over a small
  Qwen3-8B (`dsparkqwen`) served on the OdyssAI-X endpoint. Catches
  confidential content NER misses — business secrets, health narrative, HR,
  legal, strategy. Runs only when `contextual:true` AND stage 1 is clean.
  ~1-4 s/msg. Config-driven (`GUARD_LLM_BASE`, empty = disabled). Fail-open.

## API

- `GET /health` → `{status, service, model, loaded, contextual_ready}`
- `POST /guard` `{text, threshold?, contextual?}` → `{sensitive, max_severity, findings[], latency_ms}`

`sensitive` = any high-severity category, or 2+ medium categories, or (stage 2)
a contextual-confidential verdict.

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

## Stage 2 — contextual detection (build + install)

```bash
cd ~/guard-service
uv pip install --python .venv/bin/python dspy openai optuna   # optuna: MIPROv2
# 1. build the synthetic training set (fictional; needs the LLM endpoint):
#    (build_dataset.py is the local generator; the committed train set was
#     produced by a Claude workflow — either source works, it's just JSONL)
python build_dataset.py                 # → data/contextual_train.jsonl
# 2. optimise the DSPy program + measure P/R/F1 on the held-out seed set:
python optimize.py                      # → data/compiled_contextual.json
# 3. set GUARD_LLM_BASE + GUARD_LLM_MODEL in the plist, relaunch.
```

- `data/contextual_seed.jsonl` is the **held-out test set** (committed, ~24
  hand-written examples) — never used for training.
- `data/contextual_train.jsonl` is generated + gitignored (reproducible).
- `data/compiled_contextual.json` is the optimised DSPy artifact (committed).

**Latency note:** with `contextual:true`, every message that stage 1 does NOT
flag pays the stage-2 LLM latency (~1-4 s). That is a UX cost the *caller*
(Companion) controls by choosing when to send `contextual:true` — not the
sidecar. Consider gating it per profile/conversation on the Companion side.

No hardcoded host anywhere in Companion: point the add-on panel
(Settings → Add-ons → Confidential Guard) at `http://<host>:<port>/guard`.
