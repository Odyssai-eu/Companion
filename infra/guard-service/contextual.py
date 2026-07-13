"""Stage 2 — contextual confidential classifier (DSPy over dsparkqwen).

Catches CONTEXTUAL confidential content that the stage-1 NER (GLiNER) misses:
business secrets, health narrative, HR, legal, strategy — none of which is a
named entity. A DSPy program prompts a small Qwen3-8B (dsparkqwen) served on
the OdyssAI-X OpenAI-compatible endpoint.

Config-driven (no hardcoded URL): GUARD_LLM_BASE (empty = stage 2 disabled),
GUARD_LLM_MODEL (default dsparkqwen). Fail-open everywhere: any error →
classify() returns None and the caller keeps the stage-1 verdict.
"""
import os
import re
import threading

_BASE = os.environ.get("GUARD_LLM_BASE", "")           # empty → stage 2 OFF
_MODEL = os.environ.get("GUARD_LLM_MODEL", "dsparkqwen")
_COMPILED = os.path.join(os.path.dirname(__file__), "data", "compiled_contextual.json")

_VALID_CATS = {
    "business_secret",
    "health_narrative",
    "hr_personal",
    "legal_confidential",
    "strategy_internal",
    "none",
}

_program = None
_lock = threading.Lock()
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _make_lm():
    """dspy.LM pointed at the engine, thinking OFF. None when unconfigured."""
    if not _BASE:
        return None
    import dspy

    return dspy.LM(
        f"openai/{_MODEL}",
        api_base=_BASE,
        api_key="x",
        temperature=0.0,
        max_tokens=512,
        # dsparkqwen is Qwen3 → thinking is ON by default and pollutes the
        # output with <think>…</think>. Disable it at the source; we also
        # strip defensively below in case the engine ignores the flag.
        extra_body={"enable_thinking": False},
    )


def _build_signature():
    import dspy

    class ContextualConfidential(dspy.Signature):
        """Juge si un message contient de l'information CONFIDENTIELLE
        contextuelle — secret d'affaires, santé narrative, RH nominatif,
        juridique confidentiel, stratégie interne — au-delà du PII structurel
        (noms, IBAN, emails) déjà couvert ailleurs. Un sujet traité de façon
        générale ou informative n'est PAS confidentiel. Réponds en français."""

        message: str = dspy.InputField()
        sensitive: bool = dspy.OutputField(desc="true si confidentiel contextuel")
        category: str = dspy.OutputField(
            desc="business_secret|health_narrative|hr_personal|legal_confidential|strategy_internal|none"
        )
        spans: list[str] = dspy.OutputField(desc="extraits exacts qui justifient, [] si clean")
        why: str = dspy.OutputField(desc="raison courte")

    return ContextualConfidential


def load_program():
    """Lazy-load the DSPy program (thread-safe, once). Returns None when the
    stage is disabled (no GUARD_LLM_BASE) — the caller then skips stage 2."""
    global _program
    with _lock:
        if _program is not None:
            return _program
        lm = _make_lm()
        if lm is None:
            return None
        import dspy

        dspy.configure(lm=lm)
        prog = dspy.Predict(_build_signature())
        if os.path.exists(_COMPILED):
            try:
                prog.load(_COMPILED)
            except Exception:  # noqa: BLE001 — fall back to the un-optimised module
                pass
        _program = prog
        return _program


def classify(text: str):
    """Return {sensitive, category, spans} or None (stage off / any error).

    Fail-open by contract: the guard must never break a chat because the
    contextual LLM hiccuped."""
    try:
        prog = load_program()
        if prog is None:
            return None
        pred = prog(message=text)
        sensitive = bool(getattr(pred, "sensitive", False))
        if not sensitive:
            return {"sensitive": False, "category": "none", "spans": []}
        category = _THINK_RE.sub("", str(getattr(pred, "category", "none"))).strip()
        if category not in _VALID_CATS or category == "none":
            category = "business_secret"  # sensitive but unlabelled → default bucket
        spans = getattr(pred, "spans", []) or []
        if not isinstance(spans, list):
            spans = [str(spans)]
        spans = [_THINK_RE.sub("", str(s)).strip() for s in spans if str(s).strip()]
        return {"sensitive": True, "category": category, "spans": spans}
    except Exception:  # noqa: BLE001 — fail-open
        return None
