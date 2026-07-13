"""Optimise the stage-2 DSPy program (MIPROv2) and measure it on the held-out
seed set.

  python optimize.py [--base URL] [--model dsparkqwen] [--auto light]

- Trains on data/contextual_train.jsonl (split train/val internally).
- Saves the compiled program to data/compiled_contextual.json.
- Evaluates on data/contextual_seed.jsonl (NEVER used for training) and prints
  precision / recall / F1 on the `sensitive` class — the numbers that decide
  whether V2 is kept, widened, or escalated to a fine-tune (V3).
"""
import argparse
import json
import os
import sys

import dspy

HERE = os.path.dirname(__file__)


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def to_examples(rows):
    return [
        dspy.Example(
            message=r["text"],
            sensitive=(r["label"] == "sensitive"),
            category=r.get("category", "none"),
        ).with_inputs("message")
        for r in rows
    ]


def metric(example, pred, trace=None):
    """Exact match on the sensitive boolean — the load-bearing decision."""
    try:
        return bool(example.sensitive) == bool(pred.sensitive)
    except Exception:  # noqa: BLE001
        return False


def prf(examples, program):
    tp = fp = fn = tn = 0
    n_err = 0
    for ex in examples:
        try:
            pred = program(message=ex.message)
            p = bool(pred.sensitive)
        except Exception:  # noqa: BLE001 — parse/LLM failure counts as "clean" (fail-open)
            n_err += 1
            p = False
        g = bool(ex.sensitive)
        if g and p:
            tp += 1
        elif not g and p:
            fp += 1
        elif g and not p:
            fn += 1
        else:
            tn += 1
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"precision": prec, "recall": rec, "f1": f1,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn, "parse_errors": n_err}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("GUARD_LLM_BASE", "http://192.168.86.39:8000/v1"))
    ap.add_argument("--model", default=os.environ.get("GUARD_LLM_MODEL", "dsparkqwen"))
    ap.add_argument("--auto", default="light", choices=["light", "medium", "heavy"])
    ap.add_argument("--train", default=os.path.join(HERE, "data", "contextual_train.jsonl"))
    ap.add_argument("--seed", default=os.path.join(HERE, "data", "contextual_seed.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "data", "compiled_contextual.json"))
    args = ap.parse_args()

    lm = dspy.LM(f"openai/{args.model}", api_base=args.base, api_key="x",
                 temperature=0.0, max_tokens=512, extra_body={"enable_thinking": False})
    dspy.configure(lm=lm)

    from contextual import _build_signature  # reuse the exact runtime signature
    base = dspy.Predict(_build_signature())

    train_rows = load_jsonl(args.train)
    seed_rows = load_jsonl(args.seed)
    train_ex = to_examples(train_rows)
    seed_ex = to_examples(seed_rows)
    # internal train/val split (seed stays fully held out)
    cut = max(1, int(len(train_ex) * 0.8))
    trainset, valset = train_ex[:cut], train_ex[cut:]
    sys.stderr.write(f"[opt] train={len(trainset)} val={len(valset)} seed(test)={len(seed_ex)}\n")

    sys.stderr.write("[opt] baseline on seed (test):\n")
    sys.stderr.write(json.dumps(prf(seed_ex, base), indent=2) + "\n")

    optimizer = dspy.MIPROv2(metric=metric, auto=args.auto)
    compiled = optimizer.compile(base, trainset=trainset, valset=valset or trainset)
    compiled.save(args.out)
    sys.stderr.write(f"[opt] saved → {args.out}\n")

    sys.stderr.write("[opt] compiled on seed (test):\n")
    sys.stderr.write(json.dumps(prf(seed_ex, compiled), indent=2) + "\n")


if __name__ == "__main__":
    main()
