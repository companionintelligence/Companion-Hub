#!/usr/bin/env python3
"""
CI-OS Strix Halo inference stress matrix.

Measures agent failure modes on AMD Strix Halo (gfx1151) with Hub + apps running —
not tok/s saturation. Primary rollout target: ≤14B active params (matches Hub
APU_MAX_ACTIVE_PARAMS_B).

Phases:
  1 inventory   — memory, docker, vLLM metrics baseline
  2 context     — tool-call accuracy at 4K / 16K / 32K / 64K prompt budgets
  3 concurrent  — overlapping chat + tool + short-label traffic
  4 cliff       — report KV / swap pressure at current max-model-len
  5 scorecard   — weighted pass/fail for the served model

Usage:
  python3 scripts/strix-halo/stress_matrix.py
  python3 scripts/strix-halo/stress_matrix.py --phase inventory,context
  VLLM_BASE=http://127.0.0.1:8000/v1 VLLM_API_KEY=vllm-local \\
    python3 scripts/strix-halo/stress_matrix.py --out /tmp/strix-stress.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_BASE = os.environ.get("VLLM_BASE", "http://127.0.0.1:8000/v1").rstrip("/")
DEFAULT_KEY = os.environ.get("VLLM_API_KEY", "vllm-local")
DEFAULT_MODEL = os.environ.get("VLLM_MODEL", "")  # empty → first /v1/models id
METRICS_URL = os.environ.get("VLLM_METRICS", "http://127.0.0.1:8000/metrics")

# Hub APU heuristic — dense models above this are not recommended on Strix Halo.
APU_MAX_ACTIVE_PARAMS_B = 14

# Weighted scorecard (plan Phase 5).
WEIGHTS = {
    "tool_accuracy": 0.40,
    "context_break": 0.25,
    "p95_latency": 0.20,
    "memory_headroom": 0.15,
}

# Tool scenarios: each must produce a parseable tool call for the named function.
TOOL_SCENARIOS = [
    {
        "id": "list_files",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List files in a directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Directory path"},
                        },
                        "required": ["path"],
                    },
                },
            }
        ],
        "user": "List the files in /home/ci/devel using the list_files tool. Do not answer in prose.",
        "expect_name": "list_files",
        "expect_arg_key": "path",
    },
    {
        "id": "read_file",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                        },
                        "required": ["path"],
                    },
                },
            }
        ],
        "user": "Read /etc/hostname with the read_file tool. Tool call only.",
        "expect_name": "read_file",
        "expect_arg_key": "path",
    },
    {
        "id": "search_memory",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "search_memory",
                    "description": "Search personal memory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer"},
                        },
                        "required": ["query"],
                    },
                },
            }
        ],
        "user": "Search memory for 'calendar meetings this week' with limit 5 via search_memory.",
        "expect_name": "search_memory",
        "expect_arg_key": "query",
    },
    {
        "id": "run_shell",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "run_shell",
                    "description": "Run a safe shell command",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string"},
                        },
                        "required": ["command"],
                    },
                },
            }
        ],
        "user": "Run `uname -r` using the run_shell tool.",
        "expect_name": "run_shell",
        "expect_arg_key": "command",
    },
    {
        "id": "multi_tool_pick",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Weather for a city",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}},
                        "required": ["city"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_time",
                    "description": "Current time in a timezone",
                    "parameters": {
                        "type": "object",
                        "properties": {"timezone": {"type": "string"}},
                        "required": ["timezone"],
                    },
                },
            },
        ],
        "user": "What time is it in America/Los_Angeles? Use the get_time tool only.",
        "expect_name": "get_time",
        "expect_arg_key": "timezone",
    },
]


@dataclass
class PhaseResult:
    name: str
    ok: bool
    detail: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


def _http_json(
    method: str,
    url: str,
    body: dict | None = None,
    headers: dict | None = None,
    timeout: float = 300.0,
) -> tuple[int, Any, float]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            elapsed = time.perf_counter() - t0
            return resp.status, json.loads(raw) if raw else None, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.perf_counter() - t0
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw else {"error": str(e)}
        except json.JSONDecodeError:
            parsed = {"error": raw or str(e)}
        return e.code, parsed, elapsed
    except Exception as e:  # noqa: BLE001 — surface as soft failure in report
        elapsed = time.perf_counter() - t0
        return 0, {"error": str(e)}, elapsed


def _http_text(url: str, timeout: float = 10.0) -> str:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return ""


def _sh(cmd: list[str], timeout: float = 30.0) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"


def _parse_meminfo() -> dict[str, float]:
    out: dict[str, float] = {}
    try:
        text = Path("/proc/meminfo").read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        m = re.match(r"^(\w+):\s+(\d+)\s+kB", line)
        if m:
            out[m.group(1)] = int(m.group(2)) / 1024 / 1024  # GiB
    return out


def _parse_metrics(text: str) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        # vllm:kv_cache_usage_perc{...} 0.01
        m = re.match(r"^([a-zA-Z0-9_:]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$", line)
        if not m:
            continue
        name, val = m.group(1), float(m.group(2))
        # Keep last / preferred keys for gauges we care about.
        if name in (
            "vllm:num_requests_running",
            "vllm:num_requests_waiting",
            "vllm:kv_cache_usage_perc",
        ) or name.endswith("num_requests_running") or name.endswith("kv_cache_usage_perc"):
            metrics[name.split(":")[-1] if ":" in name else name] = val
            metrics[name] = val
    return metrics


def _pad_to_approx_tokens(base: str, target_tokens: int) -> str:
    """Pad with repetitive filler. ~4 chars/token heuristic for English-ish text."""
    if target_tokens <= 0:
        return base
    need_chars = max(0, target_tokens * 4 - len(base))
    filler = (
        " Context filler for stress testing. "
        "Measure truncation and tool-call integrity under long prompts. "
    )
    reps = (need_chars // len(filler)) + 1
    return base + (filler * reps)[:need_chars]


def resolve_model(base: str, key: str, preferred: str) -> tuple[str, int | None]:
    status, body, _ = _http_json("GET", f"{base}/models", headers={"Authorization": f"Bearer {key}"})
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"Cannot list models at {base}/models (status={status}): {body}")
    models = body.get("data") or []
    if not models:
        raise RuntimeError("No models served")
    if preferred:
        for m in models:
            if m.get("id") == preferred:
                return preferred, m.get("max_model_len")
        raise RuntimeError(f"Model {preferred!r} not in {[m.get('id') for m in models]}")
    m0 = models[0]
    return m0["id"], m0.get("max_model_len")


def _parse_tool_json_blob(blob: str) -> tuple[str | None, dict | None]:
    try:
        obj = json.loads(blob)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(obj, dict):
        return None, None
    name = obj.get("name") or obj.get("function")
    args = obj.get("arguments") or obj.get("parameters") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"_raw": args}
    return (str(name) if name else None), (args if isinstance(args, dict) else None)


def _first_json_object(text: str) -> str | None:
    """Extract the first top-level JSON object, handling nested braces."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_tool_call(resp: dict) -> tuple[str | None, dict | None, str]:
    """Return (name, args, channel).

    channel is:
      - structured: OpenAI tool_calls[] (what OpenClaw/Hermes want from vLLM)
      - content: model emitted <tool_call>/<tools>/<function-calls> XML in text
      - none
    """
    try:
        msg = resp["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None, None, "none"
    tcs = msg.get("tool_calls") or []
    if tcs:
        fn = tcs[0].get("function") or {}
        name = fn.get("name")
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
        except json.JSONDecodeError:
            args = {"_raw": args_raw}
        return name, (args if isinstance(args, dict) else None), "structured"

    content = msg.get("content") or ""
    # Template asks for <tool_call>; this AWQ often emits <tools> / <function-calls>.
    for pattern in (
        r"<tool_call>(.*?)</tool_call>",
        r"<tools>(.*?)</tools>",
        r"<function-calls>(.*?)</function-calls>",
    ):
        m = re.search(pattern, content, re.DOTALL)
        if not m:
            continue
        blob = _first_json_object(m.group(1)) or m.group(1).strip()
        name, args = _parse_tool_json_blob(blob)
        if name:
            return name, args, "content"
    # Last resort: bare JSON object with name+arguments in content.
    bare = _first_json_object(content)
    if bare:
        name, args = _parse_tool_json_blob(bare)
        if name:
            return name, args, "content"
    return None, None, "none"


def chat_completion(
    base: str,
    key: str,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    max_tokens: int = 512,
    temperature: float = 0.0,
    extra: dict | None = None,
    tool_choice: str | dict = "auto",
) -> tuple[int, dict, float]:
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    if extra:
        body.update(extra)
    return _http_json(
        "POST",
        f"{base}/chat/completions",
        body=body,
        headers={"Authorization": f"Bearer {key}"},
        timeout=600.0,
    )


# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------


def phase_inventory(base: str, key: str, model: str, max_len: int | None) -> PhaseResult:
    mem = _parse_meminfo()
    metrics = _parse_metrics(_http_text(METRICS_URL))
    docker = _sh(
        [
            "docker",
            "stats",
            "--no-stream",
            "--format",
            "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}",
        ]
    )
    top_containers: list[str] = []
    for line in docker.strip().splitlines():
        if "\t" in line and not line.startswith("NAME"):
            top_containers.append(line)
    top_containers = sorted(
        top_containers,
        key=lambda L: _parse_docker_mem_gib(L.split("\t")[1] if "\t" in L else "0"),
        reverse=True,
    )[:12]

    swap_used = mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)
    available = mem.get("MemAvailable", 0)
    detail = {
        "model": model,
        "max_model_len": max_len,
        "apu_max_active_params_b": APU_MAX_ACTIVE_PARAMS_B,
        "mem_total_gib": round(mem.get("MemTotal", 0), 2),
        "mem_available_gib": round(available, 2),
        "swap_used_gib": round(swap_used, 2),
        "vllm_metrics": {
            "num_requests_running": metrics.get("num_requests_running") or metrics.get("vllm:num_requests_running"),
            "num_requests_waiting": metrics.get("num_requests_waiting") or metrics.get("vllm:num_requests_waiting"),
            "kv_cache_usage_perc": metrics.get("kv_cache_usage_perc") or metrics.get("vllm:kv_cache_usage_perc"),
        },
        "top_containers": top_containers,
        "notes": [
            "Hub excludes dense models with active params > 14B on x86 APUs.",
            "Primary CI-OS Strix Halo target: Qwen3.6-35B-A3B AWQ MoE (~3B active) via host vLLM.",
        ],
    }
    errors = []
    ok = True
    if available < 8:
        ok = False
        errors.append(f"MemAvailable only {available:.1f} GiB — too tight for stress")
    if swap_used > 2:
        errors.append(f"Swap already {swap_used:.1f} GiB before stress — baseline unhealthy")
        # warn but don't hard-fail inventory
    if max_len is not None and max_len < 64000:
        errors.append(
            f"max_model_len={max_len} < Hermes floor 64000 — Hermes will fail or truncate"
        )
    return PhaseResult("inventory", ok, detail, errors)


def _parse_docker_mem_gib(usage: str) -> float:
    # "8.833GiB / 62.54GiB" or "405.1MiB / ..."
    part = usage.split("/")[0].strip()
    m = re.match(r"([0-9.]+)\s*([KMGT]i?B)", part, re.I)
    if not m:
        return 0.0
    n, unit = float(m.group(1)), m.group(2).upper()
    scale = {"B": 1 / 1024**3, "KIB": 1 / 1024**2, "MIB": 1 / 1024, "GIB": 1, "TIB": 1024}
    return n * scale.get(unit, 0)


def phase_context(base: str, key: str, model: str, max_len: int | None) -> PhaseResult:
    budgets = [4096, 16384, 32768, 65536]
    if max_len:
        budgets = [b for b in budgets if b <= max_len] or [min(budgets[0], max_len)]

    rows: list[dict[str, Any]] = []
    errors: list[str] = []

    for budget in budgets:
        # Run first 3 scenarios at each budget (keep phase tractable).
        scenario_results = []
        for sc in TOOL_SCENARIOS[:3]:
            pad_tokens = max(0, budget - 800)  # leave room for tools + completion
            user = _pad_to_approx_tokens(sc["user"], pad_tokens)
            # Prefer thinking off for tool accuracy when server supports it.
            extra = {"chat_template_kwargs": {"enable_thinking": False}}
            status, body, elapsed = chat_completion(
                base,
                key,
                model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a tool-using agent. Always call a tool; never answer in prose.",
                    },
                    {"role": "user", "content": user},
                ],
                tools=sc["tools"],
                max_tokens=256,
                extra=extra,
                tool_choice="auto",
            )
            name, args, channel = extract_tool_call(body if isinstance(body, dict) else {})
            intent_ok = (
                status == 200
                and name == sc["expect_name"]
                and isinstance(args, dict)
                and sc["expect_arg_key"] in args
            )
            structured_ok = intent_ok and channel == "structured"
            err = None
            if status != 200:
                err = f"http {status}: {body}"
            elif not intent_ok:
                err = f"got tool={name!r} args={args!r} channel={channel}"
            elif not structured_ok:
                err = f"intent ok via {channel} (not OpenAI tool_calls[])"
            scenario_results.append(
                {
                    "scenario": sc["id"],
                    "pass": intent_ok,  # model meant to call the tool
                    "structured_pass": structured_ok,  # vLLM returned tool_calls[]
                    "channel": channel,
                    "latency_s": round(elapsed, 3),
                    "error": err,
                }
            )
            if err:
                errors.append(f"ctx={budget} {sc['id']}: {err}")

        # Also probe tool_choice=required at this budget (guided path OpenClaw can use).
        sc0 = TOOL_SCENARIOS[0]
        st, bd, el = chat_completion(
            base,
            key,
            model,
            messages=[{"role": "user", "content": sc0["user"]}],
            tools=sc0["tools"],
            max_tokens=128,
            tool_choice="required",
        )
        rn, ra, rc = extract_tool_call(bd if isinstance(bd, dict) else {})
        required_ok = st == 200 and rn == sc0["expect_name"] and rc == "structured"

        passed_n = sum(1 for r in scenario_results if r["pass"])
        structured_n = sum(1 for r in scenario_results if r["structured_pass"])
        rows.append(
            {
                "budget_tokens": budget,
                "passed": passed_n,
                "structured_passed": structured_n,
                "total": len(scenario_results),
                "pass_rate": round(passed_n / max(1, len(scenario_results)), 3),
                "structured_pass_rate": round(structured_n / max(1, len(scenario_results)), 3),
                "required_structured_ok": required_ok,
                "required_latency_s": round(el, 3),
                "scenarios": scenario_results,
            }
        )

    # Context break uses intent pass (tool semantics). Agent wire-format uses structured.
    break_at = None
    structured_break_at = None
    for row in rows:
        if row["pass_rate"] >= 0.66:
            break_at = row["budget_tokens"]
        else:
            break
    for row in rows:
        if row["structured_pass_rate"] >= 0.66:
            structured_break_at = row["budget_tokens"]
        else:
            break
    ok = bool(rows) and rows[0]["pass_rate"] >= 0.66
    return PhaseResult(
        "context",
        ok,
        {
            "rows": rows,
            "highest_stable_budget": break_at,
            "highest_structured_budget": structured_break_at,
            "hermes_floor_met": (break_at or 0) >= 64000,
            "note": (
                "pass_rate = tool intent (structured or content XML). "
                "structured_pass_rate = OpenAI tool_calls[] only (what OpenClaw needs)."
            ),
        },
        errors,
    )


def phase_concurrent(base: str, key: str, model: str) -> PhaseResult:
    """Overlap tool turns + short JSON labels + a chat turn (simulates full stack)."""
    latencies: list[float] = []
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    def one_tool() -> dict[str, Any]:
        sc = TOOL_SCENARIOS[0]
        status, body, elapsed = chat_completion(
            base,
            key,
            model,
            messages=[{"role": "user", "content": sc["user"]}],
            tools=sc["tools"],
            max_tokens=128,
            extra={"chat_template_kwargs": {"enable_thinking": False}},
        )
        name, args, channel = extract_tool_call(body if isinstance(body, dict) else {})
        ok = status == 200 and name == sc["expect_name"]
        return {
            "kind": "tool",
            "ok": ok,
            "structured_ok": ok and channel == "structured",
            "channel": channel,
            "latency_s": elapsed,
            "error": None if ok else body,
        }

    def one_label() -> dict[str, Any]:
        status, body, elapsed = chat_completion(
            base,
            key,
            model,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Classify this activity as one JSON object with keys "
                        'domain (string) and energy (number 0-1). Activity: "edited Python files". '
                        "JSON only."
                    ),
                }
            ],
            tools=None,
            max_tokens=64,
            extra={"chat_template_kwargs": {"enable_thinking": False}},
        )
        ok = False
        if status == 200 and isinstance(body, dict):
            try:
                content = body["choices"][0]["message"].get("content") or ""
                # tolerate fenced JSON
                m = re.search(r"\{[^{}]+\}", content)
                if m:
                    obj = json.loads(m.group(0))
                    ok = "domain" in obj and "energy" in obj
            except Exception:  # noqa: BLE001
                ok = False
        return {"kind": "label", "ok": ok, "latency_s": elapsed, "error": None if ok else body}

    def one_chat() -> dict[str, Any]:
        status, body, elapsed = chat_completion(
            base,
            key,
            model,
            messages=[{"role": "user", "content": "Reply with exactly: pong"}],
            tools=None,
            max_tokens=16,
            extra={"chat_template_kwargs": {"enable_thinking": False}},
        )
        content = ""
        if status == 200 and isinstance(body, dict):
            try:
                content = (body["choices"][0]["message"].get("content") or "").strip().lower()
            except Exception:  # noqa: BLE001
                content = ""
        ok = status == 200 and "pong" in content
        return {"kind": "chat", "ok": ok, "latency_s": elapsed, "error": None if ok else body}

    # Sequential burst that approximates overlapping consumers (true parallel would
    # require threads; keep deterministic for CI-OS host runs).
    jobs = [one_tool, one_label, one_chat, one_tool, one_label, one_tool, one_chat, one_tool]
    mem_before = _parse_meminfo()
    metrics_before = _parse_metrics(_http_text(METRICS_URL))
    for fn in jobs:
        r = fn()
        results.append({k: v for k, v in r.items() if k != "error" or not r["ok"]})
        latencies.append(r["latency_s"])
        if not r["ok"]:
            errors.append(f"{r['kind']} failed in {r['latency_s']:.1f}s")

    mem_after = _parse_meminfo()
    metrics_after = _parse_metrics(_http_text(METRICS_URL))
    swap_delta = (mem_after.get("SwapTotal", 0) - mem_after.get("SwapFree", 0)) - (
        mem_before.get("SwapTotal", 0) - mem_before.get("SwapFree", 0)
    )
    p95 = sorted(latencies)[max(0, int(len(latencies) * 0.95) - 1)] if latencies else 0
    pass_rate = sum(1 for r in results if r["ok"]) / max(1, len(results))
    ok = pass_rate >= 0.75 and swap_delta < 1.0
    return PhaseResult(
        "concurrent",
        ok,
        {
            "jobs": len(results),
            "pass_rate": round(pass_rate, 3),
            "latency_p50_s": round(statistics.median(latencies), 3) if latencies else None,
            "latency_p95_s": round(p95, 3),
            "swap_delta_gib": round(swap_delta, 3),
            "metrics_before": metrics_before,
            "metrics_after": metrics_after,
            "results": results,
        },
        errors,
    )


def phase_cliff(base: str, key: str, model: str, max_len: int | None) -> PhaseResult:
    """Report whether current max-model-len is sustainable (not a destructive sweep)."""
    mem = _parse_meminfo()
    metrics = _parse_metrics(_http_text(METRICS_URL))
    available = mem.get("MemAvailable", 0)
    swap_used = mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)
    kv = metrics.get("kv_cache_usage_perc") or metrics.get("vllm:kv_cache_usage_perc")

    # Heuristic guidance for operators raising max-model-len.
    ladder = [16384, 32768, 49152, 65536]
    advice = []
    if max_len and max_len < 65536:
        advice.append(
            f"Served max_model_len={max_len}. To climb toward 65536, restart vLLM with "
            "VLLM_MAX_MODEL_LEN raised one step and VLLM_GPU_UTIL≤0.60; re-run this suite."
        )
    if available < 15:
        advice.append("MemAvailable < 15 GiB — do not raise context further until stack shrinks.")
    if swap_used > 1:
        advice.append("Swap in use — context cliff already reached for this model+util combo.")

    ok = available >= 10 and swap_used < 2
    return PhaseResult(
        "cliff",
        ok,
        {
            "max_model_len": max_len,
            "ladder_tokens": ladder,
            "mem_available_gib": round(available, 2),
            "swap_used_gib": round(swap_used, 2),
            "kv_cache_usage_perc": kv,
            "advice": advice,
        },
        [] if ok else advice,
    )


def phase_scorecard(phases: dict[str, PhaseResult], max_len: int | None) -> PhaseResult:
    ctx = phases.get("context")
    conc = phases.get("concurrent")
    cliff = phases.get("cliff")
    inv = phases.get("inventory")

    # Tool accuracy for scoring uses intent pass; gate also requires wire-format.
    tool_score = 0.0
    structured_score = 0.0
    required_ok_rate = 0.0
    if ctx and ctx.detail.get("rows"):
        tool_score = statistics.mean(r["pass_rate"] for r in ctx.detail["rows"])
        structured_score = statistics.mean(r.get("structured_pass_rate", 0) for r in ctx.detail["rows"])
        req_flags = [1.0 if r.get("required_structured_ok") else 0.0 for r in ctx.detail["rows"]]
        required_ok_rate = statistics.mean(req_flags) if req_flags else 0.0
    elif conc:
        tool_score = float(conc.detail.get("pass_rate") or 0)
        structured_score = float(conc.detail.get("structured_pass_rate") or 0)

    # Context break: 1.0 if ≥64K stable, 0.75 if ≥32K, 0.5 if ≥16K, 0.25 if ≥4K, else 0.
    break_at = (ctx.detail.get("highest_stable_budget") if ctx else None) or 0
    structured_break = (ctx.detail.get("highest_structured_budget") if ctx else None) or 0
    if break_at >= 64000:
        context_score = 1.0
    elif break_at >= 32768:
        context_score = 0.75
    elif break_at >= 16384:
        context_score = 0.5
    elif break_at >= 4096:
        context_score = 0.25
    else:
        context_score = 0.0

    # p95: <15s → 1.0, <45s → 0.6, else 0.2 (Strix Halo agent turns are slow; absolute).
    p95 = (conc.detail.get("latency_p95_s") if conc else None) or 999
    if p95 < 15:
        latency_score = 1.0
    elif p95 < 45:
        latency_score = 0.6
    elif p95 < 120:
        latency_score = 0.3
    else:
        latency_score = 0.1

    # Memory: available≥20 & swap<1 → 1.0; available≥10 & swap<2 → 0.6; else 0.2
    avail = (cliff or inv).detail.get("mem_available_gib") if (cliff or inv) else 0
    swap = (cliff or inv).detail.get("swap_used_gib") if (cliff or inv) else 99
    if avail is None:
        avail = 0
    if swap is None:
        swap = 99
    if avail >= 20 and swap < 1:
        mem_score = 1.0
    elif avail >= 10 and swap < 2:
        mem_score = 0.6
    else:
        mem_score = 0.2

    total = (
        WEIGHTS["tool_accuracy"] * tool_score
        + WEIGHTS["context_break"] * context_score
        + WEIGHTS["p95_latency"] * latency_score
        + WEIGHTS["memory_headroom"] * mem_score
    )
    # Wire-format path for OpenClaw: structured auto OR reliable tool_choice=required.
    wire_ok = structured_score >= 0.66 or required_ok_rate >= 0.66
    # Rollout gate: weighted + intent tools + context + OpenAI tool_calls path.
    gate = total >= 0.70 and tool_score >= 0.66 and break_at >= 16384 and wire_ok
    if total >= 0.70 and tool_score >= 0.66 and break_at >= 16384 and not wire_ok:
        verdict = (
            "FAIL — tool intent OK but vLLM tool_calls[] empty under tool_choice=auto "
            "(Qwen2.5-Coder emits <tools> XML; hermes parser expects <tool_call>). "
            "Fix parser/model or force tool_choice=required in agents."
        )
    elif gate and structured_score < 0.66 and required_ok_rate >= 0.66:
        verdict = (
            "PASS (conditional) — memory/latency/intent OK; "
            "tool_choice=auto leaves tool_calls[] empty (content <tools> XML). "
            "Agents must use tool_choice=required or parse content until parser/model fixed."
        )
    elif gate:
        verdict = "PASS — candidate fit for CI-OS Strix Halo agent tier"
    else:
        verdict = "FAIL — not ready for agent rollout"
    detail = {
        "weights": WEIGHTS,
        "scores": {
            "tool_accuracy": round(tool_score, 3),
            "structured_tool_accuracy": round(structured_score, 3),
            "required_structured_rate": round(required_ok_rate, 3),
            "context_break": round(context_score, 3),
            "p95_latency": round(latency_score, 3),
            "memory_headroom": round(mem_score, 3),
        },
        "weighted_total": round(total, 3),
        "highest_stable_budget": break_at,
        "highest_structured_budget": structured_break,
        "max_model_len": max_len,
        "wire_format_ok": wire_ok,
        "rollout_gate_14b": gate,
        "verdict": verdict,
    }
    return PhaseResult("scorecard", gate, detail, [] if gate else [detail["verdict"]])


def main() -> int:
    ap = argparse.ArgumentParser(description="CI-OS Strix Halo inference stress matrix")
    ap.add_argument(
        "--phase",
        default="inventory,context,concurrent,cliff,scorecard",
        help="Comma-separated phases to run",
    )
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--key", default=DEFAULT_KEY)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out", default="", help="Write JSON report path")
    ap.add_argument("--md", default="", help="Write Markdown summary path")
    args = ap.parse_args()

    phases_wanted = [p.strip() for p in args.phase.split(",") if p.strip()]
    try:
        model, max_len = resolve_model(args.base, args.key, args.model)
    except RuntimeError as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 2

    print(f"model={model} max_model_len={max_len} base={args.base}")
    print(f"phases={phases_wanted}")
    print(f"target: ≤{APU_MAX_ACTIVE_PARAMS_B}B active params (Hub APU cap)")

    results: dict[str, PhaseResult] = {}
    order = ["inventory", "context", "concurrent", "cliff", "scorecard"]
    for name in order:
        if name not in phases_wanted:
            continue
        print(f"\n=== phase: {name} ===")
        t0 = time.perf_counter()
        if name == "inventory":
            r = phase_inventory(args.base, args.key, model, max_len)
        elif name == "context":
            r = phase_context(args.base, args.key, model, max_len)
        elif name == "concurrent":
            r = phase_concurrent(args.base, args.key, model)
        elif name == "cliff":
            r = phase_cliff(args.base, args.key, model, max_len)
        elif name == "scorecard":
            r = phase_scorecard(results, max_len)
        else:
            continue
        r.detail["elapsed_s"] = round(time.perf_counter() - t0, 2)
        results[name] = r
        status = "OK" if r.ok else "FAIL"
        print(f"→ {status} ({r.detail.get('elapsed_s')}s)")
        for e in r.errors[:8]:
            print(f"  ! {e[:200]}")
        if name == "scorecard":
            print(f"  verdict: {r.detail.get('verdict')}")
            print(f"  weighted_total: {r.detail.get('weighted_total')}")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "host_role": "ci-os-strix-halo",
        "apu_max_active_params_b": APU_MAX_ACTIVE_PARAMS_B,
        "model": model,
        "max_model_len": max_len,
        "base": args.base,
        "phases": {k: {"ok": v.ok, "detail": v.detail, "errors": v.errors} for k, v in results.items()},
    }

    out = args.out or str(
        Path("/tmp") / f"strix-halo-stress-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    )
    Path(out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nJSON report: {out}")

    md_path = args.md or out.replace(".json", ".md")
    Path(md_path).write_text(_to_markdown(report), encoding="utf-8")
    print(f"Markdown:    {md_path}")

    # Exit 0 if scorecard pass, else 1 if scorecard ran, else 0 if all run phases ok.
    if "scorecard" in results:
        return 0 if results["scorecard"].ok else 1
    return 0 if all(r.ok for r in results.values()) else 1


def _to_markdown(report: dict) -> str:
    lines = [
        "# CI-OS Strix Halo stress matrix",
        "",
        f"- Generated: `{report['generated_at']}`",
        f"- Model: `{report['model']}`",
        f"- max_model_len: `{report['max_model_len']}`",
        f"- Hub APU active-param cap: `{report['apu_max_active_params_b']}B`",
        "",
    ]
    sc = report["phases"].get("scorecard", {})
    if sc:
        d = sc.get("detail") or {}
        lines += [
            "## Scorecard",
            "",
            f"**{d.get('verdict', '?')}**",
            "",
            f"- Weighted total: `{d.get('weighted_total')}`",
            f"- Rollout gate (14B): `{'PASS' if d.get('rollout_gate_14b') else 'FAIL'}`",
            f"- Scores: `{json.dumps(d.get('scores'))}`",
            "",
        ]
    ctx = report["phases"].get("context", {})
    if ctx:
        d = ctx.get("detail") or {}
        lines += ["## Context sweep", "", "| Budget | Pass rate |", "|---|---|"]
        for row in d.get("rows") or []:
            lines.append(f"| {row['budget_tokens']} | {row['pass_rate']} ({row['passed']}/{row['total']}) |")
        lines += ["", f"Highest stable budget: `{d.get('highest_stable_budget')}`", ""]
    conc = report["phases"].get("concurrent", {})
    if conc:
        d = conc.get("detail") or {}
        lines += [
            "## Concurrent",
            "",
            f"- Pass rate: `{d.get('pass_rate')}`",
            f"- p95 latency: `{d.get('latency_p95_s')}s`",
            f"- Swap Δ: `{d.get('swap_delta_gib')} GiB`",
            "",
        ]
    inv = report["phases"].get("inventory", {})
    if inv:
        d = inv.get("detail") or {}
        lines += [
            "## Inventory",
            "",
            f"- MemAvailable: `{d.get('mem_available_gib')} GiB`",
            f"- Swap used: `{d.get('swap_used_gib')} GiB`",
            f"- vLLM metrics: `{json.dumps(d.get('vllm_metrics'))}`",
            "",
        ]
    lines += [
        "## Failure modes this suite measures",
        "",
        "1. Tool-call parse failures (wrong/missing function under load)",
        "2. Silent context truncation vs Hermes 64K floor",
        "3. Queue saturation when Hub apps share one vLLM",
        "4. Swap / MemAvailable cliff at current util × max-model-len",
        "5. Overall fitness vs Hub ≤14B APU recommendation",
        "",
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
