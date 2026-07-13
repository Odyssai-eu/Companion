"""Confidential guard sidecar — GLiNER2 PII detection service.

Detection only: returns entities found + per-category severity.
Policy decisions (warn / force-local routing) belong to the caller (Companion).
"""
import os
import time
import threading
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_ID = os.environ.get("GUARD_MODEL", "fastino/gliner2-privacy-filter-PII-multi")

# GDPR-identification model. A quasi-identifier ATTRIBUTE (salary, a medical
# term, …) alone is NOT confidential — "how do I negotiate my salary" is a
# generic topic. It becomes personal data only when tied to an IDENTITY
# (name / email / phone): "Marie's salary is 85k" identifies a person. Hard
# identifiers (IBAN, SSN, card, passport) and secrets (API key, password) are
# sensitive on their own.
HARD_IDENTIFIERS = {
    "iban",
    "social security number",
    "credit card number",
    "passport number",
}
SECRETS = {"api key", "password"}
IDENTITY = {"person name", "email", "phone number"}          # the "who"
ATTRIBUTE = {                                                # the "what about them"
    "salary",
    "medical condition",
    "health data",
    "date of birth",
    "physical address",
}

# Per-category severity — for the finding's display tone only. The sensitive
# DECISION uses the tier logic in guard(), not this.
CATEGORIES = {c: "high" for c in HARD_IDENTIFIERS | SECRETS}
CATEGORIES.update({c: "medium" for c in IDENTITY | ATTRIBUTE})
CATEGORIES["company name"] = "low"

app = FastAPI(title="guard-service")
_model = None
_lock = threading.Lock()


def get_model():
    global _model
    with _lock:
        if _model is None:
            from gliner2 import GLiNER2
            _model = GLiNER2.from_pretrained(MODEL_ID)
        return _model


class GuardRequest(BaseModel):
    text: str
    threshold: float = 0.5
    # Stage 2 — contextual confidential detection (DSPy + LLM). Off by default
    # so the V0 contract is byte-identical; the caller opts in per request.
    contextual: bool = False


class GuardResponse(BaseModel):
    sensitive: bool
    max_severity: str  # none | low | medium | high
    findings: list  # [{category, severity, spans: [str]}]
    latency_ms: float


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "guard",
        "model": MODEL_ID,
        "loaded": _model is not None,
        # True when the stage-2 contextual endpoint is configured (GUARD_LLM_BASE).
        "contextual_ready": bool(os.environ.get("GUARD_LLM_BASE", "")),
    }


@app.post("/guard", response_model=GuardResponse)
def guard(req: GuardRequest):
    t0 = time.time()
    model = get_model()
    result = model.extract_entities(req.text, list(CATEGORIES), threshold=req.threshold)
    findings = []
    present = set()
    for cat, spans in result.get("entities", {}).items():
        if not spans:
            continue
        findings.append({"category": cat, "severity": CATEGORIES.get(cat, "low"), "spans": spans})
        present.add(cat)
    # RGPD identification: a personal ATTRIBUTE tied to an IDENTITY. Hard
    # identifiers and secrets are sensitive on their own. A quasi-identifier
    # alone (a salary figure, a medical term in a generic question) is NOT.
    sensitive = bool(
        (present & HARD_IDENTIFIERS)
        or (present & SECRETS)
        or ((present & IDENTITY) and (present & ATTRIBUTE))
    )
    max_sev = "high" if sensitive else "none"

    # Stage 2 — contextual. Runs ONLY when asked AND stage 1 is clean: no point
    # paying the LLM latency once the PII pass already flagged the message.
    # Fully fail-open: classify() returns None on any error (LLM down, parse
    # failure, stage disabled) and we keep the stage-1 verdict untouched.
    if req.contextual and not sensitive:
        from contextual import classify

        ctx = classify(req.text)
        if ctx and ctx.get("sensitive"):
            findings.append({
                "category": ctx["category"],
                "severity": "high",
                "spans": ctx.get("spans", []),
            })
            max_sev = "high"
            sensitive = True

    return GuardResponse(
        sensitive=sensitive,
        max_severity=max_sev,
        findings=findings,
        latency_ms=round((time.time() - t0) * 1000, 1),
    )
