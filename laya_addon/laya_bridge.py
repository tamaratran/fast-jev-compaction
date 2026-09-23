#!/usr/bin/env python3
"""
Laya CLI / Stdin JSON Bridge
Reads state and questions JSON from stdin, invokes Laya, and outputs the Jev-compatible response JSON.
"""

import json
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Laya JSON Bridge")
    parser.add_argument("--mock", action="store_true", help="Use mock predictor without loading torch weights")
    parser.add_argument("--device", type=str, default=None, help="Torch device")
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
        from laya_server import mock_predict
        res = mock_predict(state, questions)
    else:
        try:
            import laya
            from laya import Router
            kwargs = {"preload": True}
            if args.device:
                kwargs["device"] = args.device
            router = Router(**kwargs)
            
            predict_kwargs = {}
            if model_override and model_override not in ("jev-latest", "laya-latest", "default"):
                predict_kwargs["model"] = model_override
                
            res_raw = router.predict(state, questions, **predict_kwargs)
            res = {
                "model": res_raw.get("model", "laya-router"),
                "answers": res_raw.get("answers", {}),
                "routing": res_raw.get("routing", {})
            }
        except ImportError as e:
            sys.stderr.write(f"Warning: laya package unavailable ({e}), using mock prediction\n")
            from laya_server import mock_predict
            res = mock_predict(state, questions)

    print(json.dumps(res))

if __name__ == "__main__":
    main()
