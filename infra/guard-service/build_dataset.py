"""Synthetic dataset builder for the guard's contextual (stage 2) classifier.

Generates FICTIONAL labelled examples of contextual-confidential messages
(business secrets, health narrative, HR, legal, strategy) plus hard negatives,
by prompting a strong model on the OdyssAI-X OpenAI-compatible endpoint.

No real data — everything is invented by the generator. Output:
  data/contextual_train.jsonl   {text, label, category, why}

Usage:
  python build_dataset.py [--base URL] [--generator MODEL] [--per-cat N] [--clean N]

The seed set (data/contextual_seed.jsonl) is the held-out TEST set and is
NEVER produced here — keep them separate (no data leak into optimisation).
"""
import argparse
import json
import os
import re
import sys

from openai import OpenAI

SENSITIVE_CATEGORIES = {
    "business_secret": "secrets d'affaires : perte/gain de client nommé, chiffres financiers non publics, marges, pricing interne, specs produit non annoncées, métriques dissimulées",
    "health_narrative": "santé racontée : diagnostic/traitement d'une personne (soi ou un tiers nommé/identifiable), état de santé mentale, grossesse non annoncée — SANS forcément de terme médical technique",
    "hr_personal": "RH nominatif : licenciement/promotion d'une personne nommée non encore communiqué, salaire/rémunération individuelle, évaluation confidentielle, conflit interne",
    "legal_confidential": "juridique confidentiel : position dans un litige, stratégie d'avocat, règlement à l'amiable secret, exposition financière d'un procès, enquête interne",
    "strategy_internal": "stratégie interne non publique : M&A prévu, fermeture de site, délocalisation, pivot, plan non annoncé aux équipes/au marché",
}

SYS = (
    "Tu génères un jeu de données SYNTHÉTIQUE et FICTIF pour entraîner un "
    "détecteur de contenu confidentiel. Tout est inventé. Tu réponds "
    "EXCLUSIVEMENT en JSONL : une ligne = un objet JSON, aucun texte autour, "
    "aucun bloc de code markdown. Chaque objet a EXACTEMENT les clés : "
    'text (string), label (string), category (string), why (string courte). '
    "Varie fortement le style, la longueur, le registre (FR majoritaire, "
    "quelques EN). Pas de doublons."
)


def _clean_llm_text(s: str) -> str:
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL)
    s = re.sub(r"^```[a-zA-Z]*\n?", "", s.strip())
    s = re.sub(r"\n?```$", "", s.strip())
    return s.strip()


def _parse_jsonl(raw: str, want_label: str, want_cats: set) -> list:
    out = []
    for line in _clean_llm_text(raw).splitlines():
        line = line.strip().rstrip(",")
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not all(k in obj for k in ("text", "label", "category", "why")):
            continue
        if not isinstance(obj["text"], str) or len(obj["text"].strip()) < 8:
            continue
        # Force the label/category we asked for — the generator sometimes drifts.
        obj["label"] = want_label
        if obj.get("category") not in want_cats:
            obj["category"] = next(iter(want_cats))
        out.append({k: obj[k] for k in ("text", "label", "category", "why")})
    return out


def generate_batch(client, model, user_prompt, want_label, want_cats):
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": SYS},
                      {"role": "user", "content": user_prompt}],
            temperature=0.95,
            max_tokens=3000,
            extra_body={"enable_thinking": False},
        )
        return _parse_jsonl(resp.choices[0].message.content or "", want_label, want_cats)
    except Exception as e:  # noqa: BLE001 — generation is best-effort
        sys.stderr.write(f"[build] batch failed ({want_label}): {e}\n")
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("GUARD_LLM_BASE", "http://192.168.86.39:8000/v1"))
    ap.add_argument("--generator", default="or02:glm-5.2")
    ap.add_argument("--per-cat", type=int, default=45, help="sensitive examples per category")
    ap.add_argument("--clean", type=int, default=210, help="clean examples total")
    ap.add_argument("--out", default="data/contextual_train.jsonl")
    args = ap.parse_args()

    client = OpenAI(base_url=args.base, api_key="x")
    seen = set()
    rows = []

    # Sensitive — per category, several batches for diversity.
    for cat, desc in SENSITIVE_CATEGORIES.items():
        got = 0
        tries = 0
        while got < args.per_cat and tries < 8:
            tries += 1
            prompt = (
                f"Génère 15 messages FICTIFS qu'un employé pourrait taper dans un "
                f"chat IA et qui contiennent du CONFIDENTIEL de type « {cat} » : {desc}. "
                f'Pour chacun: label="sensitive", category="{cat}". Varie les entreprises, '
                f"noms et montants inventés. JSONL strict, 15 lignes."
            )
            batch = generate_batch(client, args.generator, prompt, "sensitive", {cat})
            for r in batch:
                key = r["text"].strip().lower()
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
                got += 1
        sys.stderr.write(f"[build] {cat}: {got}\n")

    # Clean — mix of generic-topic (hard negatives), technical, creative, small talk.
    clean_flavors = [
        "questions GÉNÉRIQUES/informatives sur le business, la finance, le SaaS, le management — SANS aucune donnée interne réelle (ex: « comment calcule-t-on le churn ? »)",
        "questions GÉNÉRIQUES sur la santé, la médecine, le droit du travail, la procédure de licenciement — de façon informative, AUCUN cas personnel identifiable",
        "demandes techniques (code, maths, traduction, rédaction) totalement neutres",
        "demandes créatives (histoires, poèmes, idées) sans info confidentielle",
        "small talk, salutations, questions banales du quotidien",
    ]
    per_flavor = max(1, args.clean // len(clean_flavors))
    for flavor in clean_flavors:
        got = 0
        tries = 0
        while got < per_flavor and tries < 8:
            tries += 1
            prompt = (
                f"Génère 15 messages FICTIFS de chat IA, tous NON confidentiels : {flavor}. "
                f'Pour chacun: label="clean", category="none". Ce sont des NÉGATIFS DURS : '
                f"ils peuvent parler de business/santé/RH/juridique mais de façon générale, "
                f"jamais une info interne réelle. JSONL strict, 15 lignes."
            )
            batch = generate_batch(client, args.generator, prompt, "clean", {"none"})
            for r in batch:
                key = r["text"].strip().lower()
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
                got += 1
        sys.stderr.write(f"[build] clean/{flavor[:30]}: {got}\n")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    n_sens = sum(1 for r in rows if r["label"] == "sensitive")
    n_clean = sum(1 for r in rows if r["label"] == "clean")
    sys.stderr.write(f"[build] wrote {len(rows)} rows ({n_sens} sensitive, {n_clean} clean) → {args.out}\n")


if __name__ == "__main__":
    main()
