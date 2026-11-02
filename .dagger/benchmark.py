#!/usr/bin/env python3
"""Measure complete Dagger calls and preserve commands, results, and logs as JSONL."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dagger", default="dagger")
    parser.add_argument("--source", default=".", help="Frozen checkout to test, independent of this module checkout")
    parser.add_argument("--pipeline", default="shared")
    parser.add_argument("--tasks", default="")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=3600)
    parser.add_argument("--mode", choices=["replay", "checks", "fresh-deps"], default="checks")
    parser.add_argument("--cache-scope", default="default")
    parser.add_argument("--integration", action="store_true")
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--no-secure", action="store_true")
    parser.add_argument("--output", default=".dagger/results/benchmarks.jsonl")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.integration and args.tasks:
        parser.error("--tasks does not apply to --integration")

    source = Path(args.source).resolve()
    if not source.is_dir():
        parser.error("--source must be an existing checkout directory")
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    output = Path(args.output)
    if output.is_absolute() or ".." in output.parts:
        parser.error("--output must be inside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)
    commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = bool(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True))
    module_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    module_dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], text=True))
    version = subprocess.check_output([args.dagger, "version"], text=True).strip()
    failed = False

    for run in range(1, args.runs + 1):
        identifier = uuid.uuid4().hex
        command = [args.dagger, "--progress=plain", "-m", ".dagger", "call"]
        command += ["integration"] if args.integration else ["check"]
        command += [f"--source={source}"]
        scope = identifier if args.mode == "fresh-deps" else args.cache_scope
        command += [f"--cache-scope={scope}"]
        if args.mode != "replay":
            command += [f"--execution-id={identifier}"]
        if args.integration:
            command += [f"--shards={args.shards}", f"--shard={args.shard}"]
            command += [f"--secure={str(not args.no_secure).lower()}"]
        else:
            command += [f"--pipelines={args.pipeline}", f"--concurrency={args.concurrency}"]
            if args.tasks:
                command += [f"--tasks={args.tasks}"]
        stdout_path = output.parent / f"{identifier}.stdout.json"
        stderr_path = output.parent / f"{identifier}.stderr.log"
        started = datetime.now(timezone.utc).isoformat()
        print(shlex.join(command), file=sys.stderr, flush=True)
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
            start = time.perf_counter()
            try:
                result = subprocess.run(
                    command, stdout=stdout, stderr=stderr, check=False,
                    timeout=args.timeout_seconds,
                )
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                exit_code = 124
                stderr.write(f"\nBenchmark timeout after {args.timeout_seconds} seconds\n")
            seconds = time.perf_counter() - start
        record = {
            "started_at": started, "commit": commit, "dirty": dirty,
            "source": str(source), "module_commit": module_commit,
            "module_dirty": module_dirty,
            "dagger_version": version, "mode": args.mode, "run": run,
            "command": command, "wall_seconds": seconds, "exit_code": exit_code,
            "timeout_seconds": args.timeout_seconds,
            "stdout": str(stdout_path), "stderr": str(stderr_path),
        }
        try:
            record["result"] = json.loads(stdout_path.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        with output.open("a") as records:
            records.write(json.dumps(record) + "\n")
        print(json.dumps(record), flush=True)
        failed = failed or exit_code != 0
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
