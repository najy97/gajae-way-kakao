#!/usr/bin/env python3
"""Scenario test harness for the contest bot.

Each case runs in its own loopback conversation inside the runtime container
(`gajaeway chat --conversation <id> --once`), so cases never share context.
The persona, tools and model are the ones the Kakao rooms get; only the
transport differs (no Kakao bubbles).

Case file format (YAML or JSON), tests/cases/*.yaml:

  - name: 입국심사 거절 사유
    tags: [decision]
    turns:
      - say: |
          여러 줄 메시지도 그대로 보낸다
        expect:
          contains: ["거절"]          # every item must appear (case-insensitive)
          any: ["규칙 3", "3번"]       # at least one must appear
          not_contains: ["SOUL.md"]    # none may appear
          regex: ["\\d{4}-\\d{2}-\\d{2}"]
          json: true                    # whole reply must be JSON (code fences allowed)
          json_keys: ["decision", "reason"]
          max_chars: 1000
          max_seconds: 240
          silent: true                  # expect no reply at all ([SILENT]); otherwise an
                                        # empty reply always fails, even without expect
      - room: b                         # optional: this turn runs in a separate room (default main)
        say: 다른 방에서 보낸 메시지

Usage:
  tests/run.py                     all cases in tests/cases
  tests/run.py -k 입국 -j 4        filter by name/tag/file name, 4 cases in parallel
  tests/run.py --smoke             one quick end-to-end check
  tests/run.py path/to/file.yaml   specific files
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent.parent
CASES_DIR = DEPLOY / "tests" / "cases"
REPORTS_DIR = DEPLOY.parent / "logs" / "tests"
DEFAULT_MAX_SECONDS = 240  # adapter answers through the callback only while it is < 255 s old
DEFAULT_MAX_CHARS = 3000  # one Kakao reply carries at most 3 bubbles x 1,000 chars
TURN_TIMEOUT = 600

SMOKE_CASE = {
    "name": "smoke",
    # Task-agnostic: once knowledge/ defines a task, off-topic questions are refused by design.
    "turns": [{"say": "안녕하세요, 무엇을 도와주실 수 있나요?", "expect": {"regex": [r"\S"], "max_seconds": 180}}],
}


def load_cases(paths: list[Path]) -> list[dict]:
    cases: list[dict] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if path.suffix in (".yaml", ".yml"):
            import yaml  # type: ignore

            data = yaml.safe_load(text)
        else:
            data = json.loads(text)
        for index, case in enumerate(data or [], 1):
            turns = case.get("turns") if isinstance(case, dict) else None
            if not case.get("name") or not isinstance(turns, list) or not turns or not all(
                isinstance(t, dict) and str(t.get("say", "")).strip() for t in turns
            ):
                raise SystemExit(f"{path.name} case #{index}: needs a name and turns that each have `say`")
            case.setdefault("source", path.name)
            cases.append(case)
    return cases


def chat_once(conversation: str, text: str) -> tuple[str, float, str]:
    cmd = [
        "docker", "compose", "-f", str(DEPLOY / "compose.yaml"), "exec", "-T", "runtime",
        "setpriv", "--reuid=1001", "--regid=1001", "--init-groups",
        "gajaeway", "chat", "--conversation", conversation, "--once",
    ]
    started = time.monotonic()
    try:
        proc = subprocess.run(cmd, input=text, capture_output=True, text=True, timeout=TURN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "", time.monotonic() - started, f"harness timeout {TURN_TIMEOUT}s"
    elapsed = time.monotonic() - started
    error = "" if proc.returncode == 0 else (proc.stderr.strip() or f"exit {proc.returncode}")
    return proc.stdout.strip(), elapsed, error


def parse_json_reply(reply: str):
    body = reply.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", body, re.S)
    if fenced:
        body = fenced.group(1)
    return json.loads(body)


def check(reply: str, elapsed: float, expect: dict) -> list[str]:
    failures: list[str] = []
    if expect.get("silent"):
        return [] if not reply else [f"expected silence, got {len(reply)} chars"]
    if not reply:
        # Silence would pass every not_contains check; it is never a pass unless asked for.
        return ["empty reply"]
    low = reply.lower()
    for item in expect.get("contains", []):
        if str(item).lower() not in low:
            failures.append(f"missing {item!r}")
    options = expect.get("any", [])
    if options and not any(str(o).lower() in low for o in options):
        failures.append(f"none of {options!r}")
    for item in expect.get("not_contains", []):
        if str(item).lower() in low:
            failures.append(f"forbidden {item!r}")
    for pattern in expect.get("regex", []):
        if not re.search(pattern, reply, re.S):
            failures.append(f"regex {pattern!r} not matched")
    if expect.get("json") or expect.get("json_keys"):
        try:
            value = parse_json_reply(reply)
            missing = [k for k in expect.get("json_keys", []) if not isinstance(value, dict) or k not in value]
            if missing:
                failures.append(f"json keys missing {missing}")
        except (json.JSONDecodeError, ValueError) as error:
            failures.append(f"not JSON ({error})")
    max_chars = expect.get("max_chars", DEFAULT_MAX_CHARS)
    if len(reply) > max_chars:
        failures.append(f"{len(reply)} chars > {max_chars}")
    max_seconds = expect.get("max_seconds", DEFAULT_MAX_SECONDS)
    if elapsed > max_seconds:
        failures.append(f"{elapsed:.0f}s > {max_seconds}s")
    return failures


@dataclass
class CaseResult:
    name: str
    source: str
    passed: bool = True
    turns: list[dict] = field(default_factory=list)


def run_case(case: dict, run_id: str, index: int) -> CaseResult:
    # Unique per run and per case position, independent of the (possibly repeated) name.
    conversation = f"test-{run_id}-{index:03d}"
    result = CaseResult(case["name"], case.get("source", "-"))
    for index, turn in enumerate(case.get("turns", []), 1):
        room = conversation if turn.get("room", "main") == "main" else f"{conversation}-{turn['room']}"
        reply, elapsed, error = chat_once(room, str(turn["say"]).rstrip("\n"))
        failures = [error] if error else check(reply, elapsed, turn.get("expect", {}))
        result.turns.append({"turn": index, "say": turn["say"], "reply": reply, "seconds": round(elapsed, 1), "failures": failures})
        if failures:
            result.passed = False
            break
    return result


def print_result(result: CaseResult, verbose: bool) -> None:
    mark = "PASS" if result.passed else "FAIL"
    total = sum(t["seconds"] for t in result.turns)
    print(f"[{mark}] {result.name} ({result.source}, {len(result.turns)} turns, {total:.0f}s)")
    for turn in result.turns:
        if turn["failures"] or verbose:
            print(f"   turn {turn['turn']} {turn['seconds']}s: {'; '.join(turn['failures']) or 'ok'}")
            reply = turn["reply"] if verbose else turn["reply"][:400]
            print("   reply: " + reply.replace("\n", "\n          "))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("-k", dest="keyword", help="run cases whose name or tags contain this text")
    parser.add_argument("-j", dest="jobs", type=int, default=1, help="cases in parallel (load test)")
    parser.add_argument("-v", dest="verbose", action="store_true", help="print every reply in full")
    parser.add_argument("--smoke", action="store_true", help="run the built-in smoke case only")
    args = parser.parse_args()

    if args.smoke:
        cases = [SMOKE_CASE]
    else:
        files = args.files or sorted(p for p in CASES_DIR.glob("*") if p.suffix in (".yaml", ".yml", ".json"))
        cases = load_cases(files)
    if args.keyword:
        key = args.keyword.lower()
        cases = [
            c
            for c in cases
            if key in c["name"].lower()
            or key in str(c.get("source", "")).lower()
            or any(key in str(t).lower() for t in c.get("tags", []))
        ]
    if not cases:
        print("no cases", file=sys.stderr)
        return 2

    run_id = f"{datetime.now().strftime('%m%d%H%M%S')}-{os.getpid()}"
    print(f"run {run_id}: {len(cases)} cases, {args.jobs} parallel")
    results: list[CaseResult] = []
    with cf.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for result in pool.map(lambda item: run_case(item[1], run_id, item[0]), enumerate(cases, 1)):
            print_result(result, args.verbose)
            results.append(result)

    passed = sum(r.passed for r in results)
    seconds = [t["seconds"] for r in results for t in r.turns]
    if seconds:
        ordered = sorted(seconds)
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        print(f"\n{passed}/{len(results)} passed; turn seconds avg {sum(seconds) / len(seconds):.0f}, p95 {p95:.0f}, max {max(seconds):.0f}")
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report = REPORTS_DIR / f"{run_id}.json"
    report.write_text(json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report: {report}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
