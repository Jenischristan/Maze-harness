#!/usr/bin/env python3
"""Evaluator for the "improve this harness" task — offline, no installs.

Scores a candidate copy of the maze-harness repository by running the checks
that are already installed, in two stages:

  1. `pnpm typecheck` + the fast suites (everything except the long fuzzers)
  2. the fuzz suites, only if stage 1 is green

Stage 1 is ~7s and stage 2 ~24s, so a broken candidate is rejected cheaply and
a good one is confirmed without skipping any test.

Score = passed_tests / max(total_tests, 1), with a 0.5 multiplier when the
typecheck fails. Tests added by the agent count in the denominator, so the only
way to raise the score is to add passing tests while keeping every existing
test green.

**No dependency installation and no network access.** The evaluator requires a
pre-installed `node_modules` inside the workspace (the harness copies it in, or
`SELF_IMPROVE_NODE_MODULES` points at one). The offline flags
(`--offline --frozen-lockfile --ignore-scripts`) guarantee pnpm never reaches
the registry if it is invoked at all.

Prints exactly one JSON line on stdout, per the harness contract.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

WORKSPACE = sys.argv[1]
LOG_DIR = os.path.join(os.environ.get("SELF_IMPROVE_LOG_DIR", "/tmp"), "self-improve")
TIMEOUT_CHECK = int(os.environ.get("SELF_IMPROVE_CHECK_TIMEOUT", "180"))
TIMEOUT_TEST = int(os.environ.get("SELF_IMPROVE_TEST_TIMEOUT", "600"))

# Suites that run quickly and cover every subsystem. The long fuzzers are
# excluded here and run in the second stage so a red candidate fails fast.
FAST_SUITES = [
    "test/core.test.ts",
    "test/git.test.ts",
    "test/context.test.ts",
    "test/live.test.ts",
    "test/sandbox.test.ts",
    "test/agent.test.ts",
    "test/tools.test.ts",
]
FUZZ_SUITES = []

# Every pnpm call is offline and side-effect free.
PNPM_OFFLINE = ["--offline", "--frozen-lockfile", "--ignore-scripts", "--reporter=silent"]


def emit(score, valid, fail_class, error, diagnostics=None):
    print(json.dumps({
        "score": None if score is None else round(float(score), 6),
        "valid": bool(valid),
        "failClass": fail_class,
        "error": error,
        "diagnostics": diagnostics or {},
    }))
    sys.exit(0)


def run(cmd, cwd, timeout):
    started = time.time()
    env = {**os.environ, "CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "npm_config_offline": "true"}
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return {
            "cmd": " ".join(cmd),
            "code": proc.returncode,
            "stdout": proc.stdout[-20000:],
            "stderr": proc.stderr[-20000:],
            "seconds": round(time.time() - started, 2),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "cmd": " ".join(cmd),
            "code": None,
            "stdout": "",
            "stderr": f"timed out after {timeout}s",
            "seconds": round(time.time() - started, 2),
            "timed_out": True,
        }
    except FileNotFoundError as exc:
        return {
            "cmd": " ".join(cmd),
            "code": None,
            "stdout": "",
            "stderr": f"command not found: {exc}",
            "seconds": 0,
            "timed_out": False,
        }


def parse_vitest(output):
    """Return (passed, failed, total) from vitest's summary line."""
    passed = failed = 0
    total = None
    m = re.search(r"Tests\s+(.+)", output)
    if m:
        line = m.group(1)
        p = re.search(r"(\d+)\s+passed", line)
        f = re.search(r"(\d+)\s+failed", line)
        t = re.search(r"\((\d+)\)\s*$", line)
        if p:
            passed = int(p.group(1))
        if f:
            failed = int(f.group(1))
        if t:
            total = int(t.group(1))
    if total is None:
        total = passed + failed
    return passed, failed, total


def node_modules_present(root):
    return os.path.isdir(os.path.join(root, "node_modules", ".bin"))


def ensure_dependencies(root):
    """Reuse an installed node_modules; never download anything."""
    if node_modules_present(root):
        return {"mode": "existing", "ok": True}

    # A shared, pre-installed node_modules can be linked in instead of installed.
    shared = os.environ.get("SELF_IMPROVE_NODE_MODULES")
    if shared and node_modules_present(shared):
        target = os.path.join(root, "node_modules")
        try:
            if os.path.islink(target) or os.path.exists(target):
                os.remove(target) if os.path.islink(target) else shutil.rmtree(target)
            os.symlink(shared, target, target_is_directory=True)
            return {"mode": "symlink", "source": shared, "ok": True}
        except OSError as exc:
            return {"mode": "symlink", "source": shared, "ok": False, "error": str(exc)}

    # Last resort: an offline, no-scripts install. It can only succeed from the
    # local pnpm store and will fail (rather than download) without it.
    pnpm = shutil.which("pnpm")
    if not pnpm:
        return {"mode": "offline-install", "ok": False, "error": "pnpm not found and node_modules missing"}
    res = run([pnpm, "install", *PNPM_OFFLINE], root, TIMEOUT_CHECK)
    return {
        "mode": "offline-install",
        "ok": res["code"] == 0 and node_modules_present(root),
        "code": res["code"],
        "stderr": res["stderr"][-2000:],
    }


def main():
    if not os.path.isdir(WORKSPACE):
        emit(None, False, "runtime", f"workspace missing: {WORKSPACE}")

    package = os.path.join(WORKSPACE, "package.json")
    if not os.path.exists(package):
        emit(None, False, "compile", "package.json is missing")

    os.makedirs(LOG_DIR, exist_ok=True)
    slug = os.path.basename(os.path.normpath(WORKSPACE)).replace("/", "_")

    def dump(name, payload):
        try:
            with open(os.path.join(LOG_DIR, f"{slug}-{name}.json"), "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2)
        except OSError:
            pass

    # ---- dependencies (offline; reuse what is already there) ------------
    deps = ensure_dependencies(WORKSPACE)
    dump("deps", deps)
    if not deps["ok"]:
        emit(
            None,
            False,
            "runtime",
            "node_modules missing and offline install failed (evaluator never downloads)",
            {"deps": deps},
        )

    pnpm = shutil.which("pnpm")
    if not pnpm:
        emit(None, False, "runtime", "pnpm not found on PATH")

    # ---- typecheck ------------------------------------------------------
    check = run([pnpm, "typecheck"], WORKSPACE, TIMEOUT_CHECK)
    dump("typecheck", check)
    typecheck_ok = check["code"] == 0

    # ---- stage 1: fast suites -------------------------------------------
    fast = run(
        ["npx", "vitest", "run", *FAST_SUITES, "--reporter=basic"],
        WORKSPACE,
        TIMEOUT_TEST,
    )
    dump("test-fast", fast)
    fast_out = fast["stdout"] + "\n" + fast["stderr"]
    fast_passed, fast_failed, fast_total = parse_vitest(fast_out)

    if fast["timed_out"]:
        emit(
            None,
            False,
            "timeout",
            f"fast test suite exceeded {TIMEOUT_TEST}s",
            {"passed": fast_passed, "failed": fast_failed, "total": fast_total},
        )
    if fast_total == 0:
        emit(
            None,
            False,
            "runtime",
            "fast test suite produced no results",
            {"typecheck_ok": typecheck_ok, "tail": fast_out[-2000:]},
        )

    # ---- stage 2: fuzzers, only when stage 1 is green --------------------
    passed, failed, total = fast_passed, fast_failed, fast_total
    stages = 1
    fuzz_seconds = None
    if typecheck_ok and fast_failed == 0:
        fuzz = run(
            ["npx", "vitest", "run", *FUZZ_SUITES, "--reporter=basic"],
            WORKSPACE,
            TIMEOUT_TEST,
        )
        dump("test-fuzz", fuzz)
        fuzz_seconds = fuzz["seconds"]
        fuzz_out = fuzz["stdout"] + "\n" + fuzz["stderr"]
        fp, ff, ft = parse_vitest(fuzz_out)
        if fuzz["timed_out"]:
            emit(
                None,
                False,
                "timeout",
                f"fuzz suite exceeded {TIMEOUT_TEST}s",
                {"passed": fast_passed + fp, "failed": fast_failed + ff, "total": fast_total + ft},
            )
        passed += fp
        failed += ff
        total += ft
        stages = 2

    if typecheck_ok:
        score = passed / max(total, 1)
    else:
        score = 0.5 * (passed / max(total, 1))

    fail_class = "ok"
    error = None
    if failed > 0:
        fail_class = "incorrect"
        error = f"{failed} test(s) failed"
    elif not typecheck_ok:
        fail_class = "compile"
        error = "typecheck failed"

    emit(
        score,
        True,
        fail_class,
        error,
        {
            "passed": passed,
            "failed": failed,
            "total": total,
            "typecheck_ok": typecheck_ok,
            "deps": deps,
            "stages": stages,
            "seconds": {
                "typecheck": check["seconds"],
                "fast": fast["seconds"],
                "fuzz": fuzz_seconds,
            },
        },
    )


if __name__ == "__main__":
    main()
