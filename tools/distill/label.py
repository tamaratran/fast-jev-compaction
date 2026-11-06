#!/usr/bin/env python3
"""Label unlabeled JSONL with clef teacher probabilities via /v1/systemone.

Reads unlabeled JSONL from stdin or --input, groups questions by shared state
(same transcript), sends one batched request per group, and writes labeled
JSONL to stdout.

Usage:
    python3 tools/distill/label.py --input training-unlabeled.jsonl \
        --model clef --base-url http://localhost:11434/v1/systemone \
        > training-labeled.jsonl
"""

import argparse
import json
import sys
import time
import urllib.request
from collections import defaultdict


def send_batch(base_url: str, model: str, state: str,
               questions: dict, retries: int = 3) -> dict:
    payload = {
        "model": model,
        "state": state,
        "questions": questions,
    }
    data = json.dumps(payload).encode()
    for attempt in range(retries):
        req = urllib.request.Request(
            base_url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer local",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                body = json.loads(resp.read())
                return body.get("answers", {})
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"  retry {attempt + 1}/{retries}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    return {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", "-i", default="-",
                        help="Unlabeled JSONL (default: stdin)")
    parser.add_argument("--model", "-m", default="clef",
                        help="Teacher model (default: clef)")
    parser.add_argument("--base-url", default="http://localhost:11434/v1/systemone")
    parser.add_argument("--batch-size", type=int, default=20,
                        help="Max questions per request (default: 20)")
    args = parser.parse_args()

    f = sys.stdin if args.input == "-" else open(args.input)
    records = []
    for line in f:
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        records.append(json.loads(line))
    if f is not sys.stdin:
        f.close()

    groups = defaultdict(list)
    for rec in records:
        tid = rec["metadata"]["transcript_id"]
        groups[tid].append(rec)

    total = len(records)
    labeled = 0
    t0 = time.time()

    for gidx, (tid, group) in enumerate(groups.items()):
        state = group[0]["payload"]["state"]

        for batch_start in range(0, len(group), args.batch_size):
            batch = group[batch_start:batch_start + args.batch_size]
            questions = {}
            id_map = {}
            for rec in batch:
                qname = rec["id"].rsplit(":", 1)[-1]
                q_obj = {
                    "type": "noul",
                    "instructions": rec["payload"]["question"],
                }
                if "criteria" in rec["payload"]:
                    q_obj["criteria"] = rec["payload"]["criteria"]
                questions[qname] = q_obj
                id_map[qname] = rec

            answers = send_batch(args.base_url, args.model, state, questions)

            for qname, rec in id_map.items():
                ans = answers.get(qname, {})
                prob = ans.get("noul", -1.0)
                labeled_rec = {
                    **rec,
                    "label": {
                        "teacher": args.model,
                        "noul": prob,
                        "keep": prob >= 0.5,
                    },
                }
                print(json.dumps(labeled_rec, separators=(",", ":")))
                labeled += 1

        elapsed = time.time() - t0
        rate = labeled / elapsed if elapsed > 0 else 0
        print(f"  [{gidx + 1}/{len(groups)}] {tid}: {len(group)} qs, "
              f"{labeled}/{total} total ({rate:.1f}/s)",
              file=sys.stderr)

    elapsed = time.time() - t0
    print(f"\nLabeled {labeled}/{total} in {elapsed:.1f}s "
          f"({labeled / elapsed:.1f}/s) with {args.model}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
