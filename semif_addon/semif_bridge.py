#!/usr/bin/env python3
"""
SemIf CLI / Stdin JSON Bridge for fast-jev-compaction.
Reads { state, questions, model } JSON from stdin, invokes SemIf
(or mock predictor), and outputs Jev-compatible response JSON to stdout.
"""

import argparse
import json
import os
import sys
from pathlib import Path


def mock_predict(state, questions):
    """Deterministic mock prediction for testing without GPU/model loaded."""
    answers = {}
    for q_name, q_def in questions.items():
        q_type = q_def.get("type", "noul")
        if q_type == "noul":
            answers[q_name] = {"type": "noul", "noul": 0.85}
        elif q_type == "choice":
            criteria = q_def.get("criteria", {})
            keys = list(criteria.keys())
            first_key = keys[0] if keys else "default"
            answers[q_name] = {
                "type": "choice",
                "choice": first_key,
                "confidence": 0.90,
                "probabilities": {k: (0.90 if k == first_key else 0.10 / max(1, len(keys) - 1)) for k in keys},
            }
        elif q_type == "score":
            answers[q_name] = {
                "type": "score",
                "score": 1.0,
                "confidence": 0.85,
                "probabilities": {"0": 0.15, "1": 0.85},
            }
    return {
        "model": "semif-mock",
        "answers": answers,
    }


def run_semif(state, questions, model_name=None, device="auto", dtype="float16", semif_dir=None):
    if semif_dir is None:
        semif_dir = os.environ.get("SEMIF_DIR")
    if semif_dir:
        semif_path = Path(semif_dir).resolve()
    else:
        # Default search in sibling directories (SemIf, semlf, semif)
        here = Path(__file__).resolve().parent
        parent_dir = here.parent.parent
        candidates = [
            parent_dir / "SemIf",
            parent_dir / "semlf",
            parent_dir / "semif",
        ]
        semif_path = candidates[0]
        for c in candidates:
            if (c / "src").is_dir():
                semif_path = c.resolve()
                break

    src_path = semif_path / "src"
    if str(src_path) not in sys.path:
        sys.path.insert(0, str(src_path))

    try:
        from semif_phase1.core import load_causal_model, validate_row
        from semif_phase1.direct import score as direct_score
    except ImportError as e:
        sys.stderr.write(f"Warning: semif_phase1 could not be imported ({e}). Falling back to mock prediction.\n")
        return mock_predict(state, questions)

    model_id = model_name or "Qwen/Qwen3.5-4B"
    revision = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"

    model, tokenizer, metadata = load_causal_model(
        source=model_id,
        revision=revision,
        device=device,
        dtype=dtype,
    )

    answers = {}
    for q_name, q_def in questions.items():
        q_type = q_def.get("type", "noul")
        instructions = q_def.get("instructions", "")

        if q_type == "noul":
            options = [
                {"id": "yes", "description": "Yes, true"},
                {"id": "no", "description": "No, false"},
            ]
            row = {
                "id": f"q_{q_name}",
                "state": state,
                "question": instructions,
                "options": options,
            }
            validate_row(row)
            res = direct_score(model, tokenizer, row, metadata)
            prob_map = dict(zip(res["option_ids"], res["probabilities"]))
            answers[q_name] = {
                "type": "noul",
                "noul": prob_map.get("yes", 0.5),
            }
        elif q_type == "choice":
            criteria = q_def.get("criteria", {})
            options = [
                {"id": k, "description": v if v else k}
                for k, v in criteria.items()
            ]
            row = {
                "id": f"q_{q_name}",
                "state": state,
                "question": instructions,
                "options": options,
            }
            validate_row(row)
            res = direct_score(model, tokenizer, row, metadata)
            prob_map = dict(zip(res["option_ids"], res["probabilities"]))
            best_choice = max(res["option_ids"], key=lambda opt: prob_map[opt])
            answers[q_name] = {
                "type": "choice",
                "choice": best_choice,
                "confidence": prob_map[best_choice],
                "probabilities": prob_map,
            }
        elif q_type == "score":
            criteria = q_def.get("criteria", [])
            options = [
                {"id": str(i), "description": desc}
                for i, desc in enumerate(criteria)
            ]
            row = {
                "id": f"q_{q_name}",
                "state": state,
                "question": instructions,
                "options": options,
            }
            validate_row(row)
            res = direct_score(model, tokenizer, row, metadata)
            prob_map = dict(zip(res["option_ids"], res["probabilities"]))
            expected_score = sum(i * prob_map.get(str(i), 0.0) for i in range(len(criteria)))
            best_idx = max(range(len(criteria)), key=lambda i: prob_map.get(str(i), 0.0))
            answers[q_name] = {
                "type": "score",
                "score": expected_score,
                "confidence": prob_map.get(str(best_idx), 0.0),
                "probabilities": prob_map,
            }

    return {
        "model": metadata.get("source", model_id),
        "answers": answers,
    }


def main():
    parser = argparse.ArgumentParser(description="SemIf JSON Bridge for fast-jev-compaction")
    parser.add_argument("--mock", action="store_true", help="Run with mock predictor without loading PyTorch weights")
    parser.add_argument("--device", type=str, default="auto", help="Device (mps, cuda, auto)")
    parser.add_argument("--dtype", type=str, default="float16", help="Precision (float16, bfloat16, float32)")
    parser.add_argument("--semif-dir", type=str, default=None, help="Path to SemIf repository root")
    args = parser.parse_args()

    input_text = sys.stdin.read()
    if not input_text.strip():
        sys.stderr.write("Error: Empty input\n")
        sys.exit(1)

    try:
        payload = json.loads(input_text)
    except Exception as e:
        sys.stderr.write(f"Error parsing JSON: {e}\n")
        sys.exit(1)

    state = payload.get("state")
    questions = payload.get("questions")
    model_override = payload.get("model")

    if state is None or questions is None:
        sys.stderr.write("Error: Missing 'state' or 'questions' in payload\n")
        sys.exit(1)

    if args.mock:
        res = mock_predict(state, questions)
    else:
        res = run_semif(
            state=state,
            questions=questions,
            model_name=model_override,
            device=args.device,
            dtype=args.dtype,
            semif_dir=args.semif_dir,
        )

    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
