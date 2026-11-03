#!/usr/bin/env python3
"""Evaluator for the factor-arena task.

A graded, correctness-gated benchmark with a genuine difficulty ladder. Each
case has a weight; correctness is all-or-nothing per case, and each case is
scored as weight / max(elapsed, eps). The total score is the sum over all
correct cases, so improving any single case (including hard ones) raises the
score continuously.

The naive baseline is expected to time out on several hard cases, so there is
real headroom: memoization, trial division by small primes, Pollard rho,
Miller-Rabin, segmented sieves, etc. all change the score.

Prints exactly one JSON line.
"""
import json
import os
import subprocess
import sys
import tempfile

WORKSPACE = sys.argv[1]
SOLUTION = os.path.join(WORKSPACE, "solution.py")

# (name, kind, arg, expected, weight, hard_timeout_seconds)
CASES = [
    ("factor_small", "factorize", 360, [2, 2, 2, 3, 3, 5], 1.0, 5),
    ("factor_medium", "factorize", 600851475143, [71, 839, 1471, 6857], 2.0, 5),
    ("factor_semiprime_19", "factorize", 1000000000000000003, [1000000000000000003], 6.0, 8),
    ("factor_semiprime_23", "factorize", 9007199254740881, [9007199254740881], 8.0, 10),
    ("totient_medium", "totient", 1000000007, 1000000006, 1.0, 5),
    ("totient_large", "totient", 56130437228687557907788, 28052674355797540771728, 6.0, 10),
    ("gap_1e5", "largest_prime_gap", 100000, 72, 1.0, 5),
    ("gap_1e6", "largest_prime_gap", 1000000, 114, 3.0, 8),
    ("gap_5e6", "largest_prime_gap", 5000000, 154, 8.0, 15),
]

RUNNER = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("solution", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
kind, arg = sys.argv[2], int(sys.argv[3])
start = __import__("time").perf_counter()
out = getattr(mod, kind)(arg)
elapsed = __import__("time").perf_counter() - start
print(json.dumps({"out": out, "elapsed": elapsed}))
"""


def fail(fail_class, message, diagnostics=None):
    print(json.dumps({
        "score": None,
        "valid": False,
        "failClass": fail_class,
        "error": message,
        "diagnostics": diagnostics or {},
    }))
    sys.exit(0)


if not os.path.exists(SOLUTION):
    fail("compile", "solution.py is missing")

with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
    fh.write(RUNNER)
    runner = fh.name

score = 0.0
passed = 0
details = []
try:
    for name, kind, arg, expected, weight, timeout_s in CASES:
        try:
            proc = subprocess.run(
                [sys.executable, "-I", runner, SOLUTION, kind, str(arg)],
                capture_output=True, text=True, timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            details.append({"case": name, "status": "timeout", "timeout": timeout_s})
            continue
        if proc.returncode != 0:
            details.append({
                "case": name,
                "status": "crash",
                "stderr": proc.stderr.strip()[:300],
            })
            continue
        try:
            payload = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:
            details.append({"case": name, "status": "no-result", "stdout": proc.stdout[:300]})
            continue
        got = payload.get("out")
        elapsed = max(float(payload.get("elapsed", timeout_s)), 1e-9)
        ok = expected is None or got == expected
        if not ok:
            details.append({"case": name, "status": "incorrect", "got": got, "expected": expected})
            continue
        passed += 1
        contribution = weight / max(elapsed, 0.01)
        score += contribution
        details.append({
            "case": name,
            "status": "ok",
            "seconds": round(elapsed, 6),
            "weight": weight,
            "contribution": round(contribution, 4),
        })
finally:
    try:
        os.unlink(runner)
    except OSError:
        pass

if passed == 0:
    fail("incorrect", "no case passed", {"cases": details})

print(json.dumps({
    "score": round(score, 6),
    "valid": True,
    "failClass": "ok",
    "error": None,
    "diagnostics": {"passed": passed, "total": len(CASES), "cases": details},
}))
