#!/usr/bin/env python3
import json
import os
import sys

workspace = sys.argv[1]
program = os.path.join(workspace, "program.json")
try:
    with open(program, "r", encoding="utf-8") as fh:
        state = json.load(fh)
    value = float(state.get("value", 0))
    generation = int(state.get("generation", 0))
except Exception as exc:  # noqa: BLE001
    print(json.dumps({
        "score": None,
        "valid": False,
        "failClass": "compile",
        "error": f"could not read program.json: {exc}",
        "diagnostics": {"workspace": workspace},
    }))
    sys.exit(0)

if value < 0:
    print(json.dumps({
        "score": None,
        "valid": False,
        "failClass": "incorrect",
        "error": "program value is negative",
        "diagnostics": {"value": value, "generation": generation},
    }))
    sys.exit(0)

print(json.dumps({
    "score": round(value, 6),
    "valid": True,
    "failClass": "ok",
    "error": None,
    "diagnostics": {"value": value, "generation": generation},
}))
