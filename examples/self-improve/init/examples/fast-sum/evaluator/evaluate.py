#!/usr/bin/env python3
"""Evaluator for the fast-sum task.

Runs the workspace's solution.py against correctness checks and times it.
Score = correctness fraction * speedup against the reference (higher is better).
Prints exactly one JSON line.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

WORKSPACE = sys.argv[1]
SOLUTION = os.path.join(WORKSPACE, "solution.py")

CASES = [
    ("sum", 50000000, 1250000025000000),
    ("fib", 32, 2178309),
    ("primes", 20000, 2262),
]

RUNNER = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("solution", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
kind, arg = sys.argv[2], int(sys.argv[3])
start = __import__("time").perf_counter()
if kind == "sum":
    out = mod.solve(arg)
elif kind == "fib":
    out = mod.fib(arg)
else:
    out = mod.count_primes(arg)
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

total_time = 0.0
correct = 0
details = []
for kind, arg, expected in CASES:
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            [sys.executable, "-I", runner, SOLUTION, kind, str(arg)],
            capture_output=True, text=True, timeout=20,
        )
    except subprocess.TimeoutExpired:
        fail("timeout", f"{kind}({arg}) exceeded 20s", {"case": kind})
    wall = time.perf_counter() - started
    if proc.returncode != 0:
        fail("runtime", f"{kind}({arg}) crashed: {proc.stderr.strip()[:400]}", {"case": kind})
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        fail("incorrect", f"{kind}({arg}) produced no result", {"stdout": proc.stdout[:400]})
    got = payload.get("out")
    elapsed = float(payload.get("elapsed", wall))
    if got != expected:
        fail("incorrect", f"{kind}({arg}) returned {got!r}, expected {expected!r}", {"case": kind})
    correct += 1
    total_time += elapsed
    details.append({"case": kind, "arg": arg, "seconds": round(elapsed, 6)})

os.unlink(runner)
# Lower total_time is better; map to a positive score. Baseline reference ~2.5s.
score = correct * (10.0 / (1.0 + total_time))
print(json.dumps({
    "score": round(score, 6),
    "valid": True,
    "failClass": "ok",
    "error": None,
    "diagnostics": {"cases": details, "totalSeconds": round(total_time, 6)},
}))
