#!/usr/bin/env python3
"""Reply latency of real KakaoTalk messages, from the gateway's own records.

For every Kakao message received in the window it prints (times in KST):
  wait   received by the gateway -> prompt handed to the model (session start/resume, queue)
  model  prompt -> first reply ready to send
  total  received -> Kakao confirmed the reply bubble
'-' means the step was not found (no reply yet, or its log line rotated away).

Usage: tests/latency.py [--minutes 60] [--room <origin substring>]
"""

from __future__ import annotations

import argparse
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent.parent
DB = "/home/gajaeway/.gajaeway/gateway.db"
KST = timezone(timedelta(hours=9))


def compose(*args: str) -> str:
    cmd = ["docker", "compose", "-f", str(DEPLOY / "compose.yaml"), *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL).stdout


def query(sql: str) -> list[list[str]]:
    out = compose("exec", "-T", "runtime", "setpriv", "--reuid=1001", "--regid=1001", "--init-groups",
                  "sqlite3", "-readonly", "-separator", "\x1f", DB, sql)
    return [line.split("\x1f") for line in out.splitlines() if line]


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def room_label(origin: str) -> str:
    kind = origin.split("/")[1] if origin.count("/") >= 2 else origin
    key = origin.split("/")[2] if origin.count("/") >= 2 else origin
    return f"{'1:1' if kind == 'dm' else '그룹'} {key[-6:]}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--minutes", type=int, default=60)
    parser.add_argument("--room", default="")
    args = parser.parse_args()

    since = f"strftime('%Y-%m-%dT%H:%M:%fZ','now','-{args.minutes} minutes')"
    inbound = query(f"select received_at, origin_key, body from inbound_messages "
                    f"where origin_key like 'kakao/%' and received_at > {since} order by received_at")
    deliveries = query(f"select created_at, updated_at, state, origin_key from deliveries "
                       f"where origin_key like 'kakao/%' and created_at > {since} order by created_at")
    # Prompt start per origin: the gateway logs persona_model right before each send.
    starts: dict[str, list[datetime]] = {}
    logs = compose("logs", "--no-log-prefix", "--since", f"{args.minutes + 5}m", "runtime")
    for line in logs.splitlines():
        match = re.match(r"(\S+Z) info persona_model origin=(\S+)", line)
        if match:
            starts.setdefault(match.group(2), []).append(ts(match.group(1)))

    rows = []
    for received_at, origin, body in inbound:
        if args.room and args.room not in origin:
            continue
        received = ts(received_at)
        reply = next((d for d in deliveries if d[3] == origin and ts(d[0]) >= received), None)
        ready = ts(reply[0]) if reply else None
        # Container recreation drops older log lines; never match a start after the reply.
        start = next((s for s in starts.get(origin, []) if s >= received and (ready is None or s <= ready)), None)
        sent = ts(reply[1]) if reply and reply[2] == "confirmed" else None
        secs = lambda a, b: f"{(b - a).total_seconds():5.1f}" if a and b else "    -"
        rows.append((received, origin, body, secs(received, start), secs(start, ready), secs(received, sent),
                     (sent - received).total_seconds() if sent else None))

    print(f"{'시각':8} {'방':12} {'wait':>5} {'model':>5} {'total':>5}  메시지")
    for received, origin, body, wait, model, total, _ in rows:
        text = body.replace("\n", " ")[:30]
        print(f"{received.astimezone(KST):%H:%M:%S} {room_label(origin):12} {wait} {model} {total}  {text}")
    totals = sorted(r[6] for r in rows if r[6] is not None)
    if totals:
        p95 = totals[min(len(totals) - 1, int(len(totals) * 0.95))]
        print(f"\n{len(totals)}건: 평균 {sum(totals) / len(totals):.1f}s, 중앙 {totals[len(totals) // 2]:.1f}s, "
              f"p95 {p95:.1f}s, 최대 {totals[-1]:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
