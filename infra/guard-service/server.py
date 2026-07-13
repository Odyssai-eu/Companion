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

# category -> severity. high = identifiers that alone make a message sensitive,
# medium = quasi-identifiers, sensitive mostly in combination.
CATEGORIES = {
    "social security number": "high",
    "iban": "high",
    "credit card number": "high",
    "passport number": "high",
    "medical condition": "high",
    "health data": "high",
    "salary": "high",
    "password": "high",
    "api key": "high",
    "person name": "medium",
    "email": "medium",
    "phone number": "medium",
    "physical address": "medium",
    "date of birth": "medium",
    "company name": "low",
}

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


class GuardResponse(BaseModel):
    sensitive: bool
    max_severity: str  # none | low | medium | high
    findings: list  # [{category, severity, spans: [str]}]
    latency_ms: float


SEV_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}


@app.get("/health")
def health():
    return {"status": "ok", "service": "guard", "model": MODEL_ID, "loaded": _model is not None}


@app.post("/guard", response_model=GuardResponse)
def guard(req: GuardRequest):
    t0 = time.time()
    model = get_model()
    result = model.extract_entities(req.text, list(CATEGORIES), threshold=req.threshold)
    findings = []
    max_sev = "none"
    for cat, spans in result.get("entities", {}).items():
        if not spans:
            continue
        sev = CATEGORIES.get(cat, "low")
        findings.append({"category": cat, "severity": sev, "spans": spans})
        if SEV_ORDER[sev] > SEV_ORDER[max_sev]:
            max_sev = sev
    # sensitive = any high, or 2+ medium categories (name+address, email+dob, ...)
    n_medium = sum(1 for f in findings if f["severity"] == "medium")
    sensitive = max_sev == "high" or n_medium >= 2
    return GuardResponse(
        sensitive=sensitive,
        max_severity=max_sev,
        findings=findings,
        latency_ms=round((time.time() - t0) * 1000, 1),
    )
