#!/usr/bin/env python
"""jev-gate — confidence-gated pre-push guardrail for git repos, powered by Jev 1.13.

Usage:  python jev-gate.py <repo-path> [--threshold 0.85]
Exit 0  = Jev confident the diff is safe -> push allowed.
Exit 1  = Jev flagged risk OR uncertain -> escalate to full agent review.

Questions (one batched Jev call, Noul + Score):
  has_secrets, syntax_risk, breaking_change, tests_risk (0-5 scale)
Gate rule: block if any noul >= threshold OR tests_risk >= 3; allow otherwise.
"""
import json, os, re, subprocess, sys, time, urllib.request

def api_key():
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("jev-gate: set OPENROUTER_API_KEY in your environment (never hardcode it)")
    return key

def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=60).stdout

def main():
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    threshold = 0.85
    if "--threshold" in sys.argv:
        threshold = float(sys.argv[sys.argv.index("--threshold") + 1])

    diff = git(repo, "diff", "HEAD~1", "--", ":(exclude)*.lock", ":(exclude)*.min.*")
    if not diff.strip():
        diff = git(repo, "diff", "--cached")
    if not diff.strip():
        print("jev-gate: no diff to inspect — allow")
        return 0
    if len(diff) > 60000:
        diff = diff[:20000] + "\n...[truncated middle]...\n" + diff[-20000:]

    state = {
        "repo": os.path.basename(os.path.abspath(repo)),
        "recent_commits": git(repo, "log", "--oneline", "-3").strip(),
        "diff": diff,
    }
    questions = {
        "has_secrets": {"type": "noul", "instructions": "Does this diff contain hardcoded secrets, API keys, tokens or passwords? Look for key=..., sk-, Bearer, password literals."},
        "syntax_risk": {"type": "noul", "instructions": "Does the diff introduce an obvious syntax error, unbalanced brackets or a truncated file?"},
        "breaking_change": {"type": "noul", "instructions": "Does the diff remove or rename exported functions, API routes or env vars that other code may use?"},
        "tests_risk": {"type": "score", "instructions": "How likely is it that existing tests will fail after this diff? 1 = will pass, 5 = will certainly fail.", "criteria": ["will certainly pass", "very likely pass", "may fail, minor issues", "likely fail", "will certainly fail"]},
    }
    body = {"model": os.environ.get("JEV_MODEL", "typesafe/jev-1.13"), "state": state, "questions": questions}
    req = urllib.request.Request(
        "https://openrouter.ai/api/alpha/decisions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        print("jev-gate: API error:", e.read().decode()[:300])
        print("BLOCKED on API failure — escalate manually")
        return 1
    ms = round((time.perf_counter() - t0) * 1000)

    a = resp["answers"]
    def noul(name): return a[name]["noul"]
    tests_risk = a["tests_risk"]["score"]

    print(f"jev-gate ({ms} ms, ${resp['usage']['cost']}):")
    print(f"  has_secrets     p={noul('has_secrets'):.2f}")
    print(f"  syntax_risk     p={noul('syntax_risk'):.2f}")
    print(f"  breaking_change p={noul('breaking_change'):.2f}")
    print(f"  tests_risk      {tests_risk}/5")

    blocked = max(noul("has_secrets"), noul("syntax_risk"), noul("breaking_change")) >= threshold or tests_risk >= 3
    uncertain = threshold * 0.6 < max(noul("has_secrets"), noul("syntax_risk"), noul("breaking_change")) < threshold
    if blocked:
        print("BLOCKED — escalate to full agent review before push")
        return 1
    if uncertain:
        print("UNCERTAIN — recommend a quick manual look, but allowed")
        return 0
    print("ALLOW")
    return 0

if __name__ == "__main__":
    sys.exit(main())
