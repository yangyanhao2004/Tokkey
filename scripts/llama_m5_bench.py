#!/usr/bin/env python3
"""Benchmark a local llama-server on Apple silicon.

The script intentionally uses only the Python standard library so it can be
copied to an M5 Mac and run without installing anything.

Recommended server startup:

    ./build/bin/llama-server \
      -m /path/to/model.gguf \
      --host 0.0.0.0 --port 8080 \
      --parallel 1 -ngl 99 -t 2 \
      -c 16384 -b 4096 -ub 4096 -fa on \
      --no-cache-prompt --metrics

`--metrics` is required only for the script's exact prefill/decode timings.
Everything else works without it.

Basic run:

    python3 scripts/llama_m5_bench.py \
      --concurrency 1,2,4,8 \
      --iterations 3 \
      --max-tokens 256

For M5 resource measurements, run once in a terminal where passwordless sudo is
available, or run `sudo -v` first:

    python3 scripts/llama_m5_bench.py \
      --concurrency 1,2,4,8 \
      --iterations 3 \
      --powermetrics

Results are written to `llama-m5-benchmark-results/<timestamp>/`.
The default prompt is read from `scripts/benchmark_prompt.txt`, which is copied
next to this script and should be deployed together with it.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


DEFAULT_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_CHAT_PATH = "/v1/chat/completions"
DEFAULT_OUTPUT_ROOT = "llama-m5-benchmark-results"
DEFAULT_PROMPT_FILE = Path(__file__).resolve().parent / "benchmark_prompt.txt"

PROMPT_PARAGRAPH = (
    "Modern language-model inference divides a request into a prompt-processing "
    "phase and a token-generation phase. Prompt processing is compute-bound and "
    "parallelizes across the GPU, while generation is memory-bound and produces "
    "one token at a time. Measured systems should therefore report prefill speed, "
    "decode speed, time to first token, tail latency, concurrency behavior, unified "
    "memory pressure, package power, and thermal throttling instead of one aggregate "
    "tokens-per-second number."
)

REQUEST_COLUMNS = [
    "concurrency",
    "worker",
    "iteration",
    "status_code",
    "started_at",
    "elapsed_ms",
    "ttft_ms",
    "decode_ms",
    "prompt_tokens",
    "output_tokens",
    "decode_tokens_per_second",
    "e2e_tokens_per_second",
    "finish_reason",
    "error",
]

HOST_COLUMNS = [
    "timestamp",
    "process_cpu_percent",
    "process_cpu_lifetime_percent",
    "process_rss_mb",
    "process_virtual_mb",
    "process_memory_percent",
    "process_power",
    "system_user_cpu_percent",
    "system_system_cpu_percent",
    "system_idle_cpu_percent",
    "load_1m",
    "load_5m",
    "load_15m",
    "memory_pressure_percent",
    "phys_memory_used_mb",
    "phys_memory_wired_mb",
    "phys_memory_compressed_mb",
    "phys_memory_unused_mb",
    "swapins_total",
    "swapouts_total",
]


@dataclass(frozen=True)
class RequestResult:
    worker: int
    iteration: int
    status_code: Optional[int]
    started_at: float
    elapsed_ms: float
    ttft_ms: Optional[float]
    decode_ms: Optional[float]
    prompt_tokens: Optional[int]
    output_tokens: Optional[int]
    finish_reason: Optional[str]
    error: Optional[str]

    def as_row(self, concurrency: int) -> Dict[str, Any]:
        output_tokens_per_second = tokens_per_second(self.output_tokens, self.decode_ms)
        total_tokens = add_optional(self.prompt_tokens, self.output_tokens)
        e2e_tokens_per_second = tokens_per_second(total_tokens, self.elapsed_ms)
        return {
            "concurrency": concurrency,
            "worker": self.worker,
            "iteration": self.iteration,
            "status_code": self.status_code,
            "started_at": f"{self.started_at:.3f}",
            "elapsed_ms": round(self.elapsed_ms, 2),
            "ttft_ms": round_optional(self.ttft_ms),
            "decode_ms": round_optional(self.decode_ms),
            "prompt_tokens": self.prompt_tokens,
            "output_tokens": self.output_tokens,
            "decode_tokens_per_second": round_optional(output_tokens_per_second),
            "e2e_tokens_per_second": round_optional(e2e_tokens_per_second),
            "finish_reason": self.finish_reason,
            "error": self.error,
        }


@dataclass
class HostSample:
    timestamp: float
    process_cpu_percent: Optional[float] = None
    process_cpu_lifetime_percent: Optional[float] = None
    process_rss_mb: Optional[float] = None
    process_virtual_mb: Optional[float] = None
    process_memory_percent: Optional[float] = None
    process_power: Optional[float] = None
    system_user_cpu_percent: Optional[float] = None
    system_system_cpu_percent: Optional[float] = None
    system_idle_cpu_percent: Optional[float] = None
    load_1m: Optional[float] = None
    load_5m: Optional[float] = None
    load_15m: Optional[float] = None
    memory_pressure_percent: Optional[float] = None
    phys_memory_used_mb: Optional[float] = None
    phys_memory_wired_mb: Optional[float] = None
    phys_memory_compressed_mb: Optional[float] = None
    phys_memory_unused_mb: Optional[float] = None
    swapins_total: Optional[int] = None
    swapouts_total: Optional[int] = None

    def as_row(self) -> Dict[str, Any]:
        row = {
            "timestamp": f"{self.timestamp:.3f}",
            **{
                column: round_optional(value)
                for column, value in asdict(self).items()
                if column not in {"timestamp", "swapins_total", "swapouts_total"}
            },
            "swapins_total": self.swapins_total,
            "swapouts_total": self.swapouts_total,
        }
        return row


class LlamaClient:
    def __init__(self, base_url: str, timeout_seconds: int):
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get_json(self, path: str) -> Dict[str, Any]:
        response = self.opener.open(self.url(path), timeout=min(self.timeout_seconds, 10))
        with response:
            return json.load(response)

    def get_text(self, path: str) -> str:
        response = self.opener.open(self.url(path), timeout=min(self.timeout_seconds, 10))
        with response:
            return response.read().decode("utf-8", errors="replace")

    def url(self, path: str) -> str:
        normalized_path = f"/{path.lstrip('/')}"
        return f"{self.base_url}{normalized_path}"

    def chat_completion(
        self,
        path: str,
        payload: Dict[str, Any],
    ) -> RequestResult:
        started_at = time.monotonic()
        request = urllib.request.Request(
            self.url(path),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream" if payload.get("stream") else "application/json",
            },
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                status_code = response.getcode()
                if payload.get("stream"):
                    return self.read_stream_response(status_code, started_at, response)
                return self.read_json_response(status_code, started_at, response)
        except urllib.error.HTTPError as error:
            return self.error_result(started_at, error.code, self.read_http_error(error))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return self.error_result(started_at, None, str(error))

    def read_stream_response(
        self,
        status_code: int,
        started_at: float,
        response: Any,
    ) -> RequestResult:
        ttft_ms: Optional[float] = None
        prompt_tokens: Optional[int] = None
        output_tokens: Optional[int] = None
        finish_reason: Optional[str] = None

        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue

            usage = chunk.get("usage")
            if isinstance(usage, dict):
                prompt_tokens = int_or_none(usage.get("prompt_tokens"))
                output_tokens = int_or_none(usage.get("completion_tokens"))

            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            if choice.get("finish_reason"):
                finish_reason = choice.get("finish_reason")
            delta = choice.get("delta") or {}
            content = delta.get("content") or delta.get("reasoning_content") or ""
            if content and ttft_ms is None:
                ttft_ms = elapsed_milliseconds(started_at)

        elapsed_ms = elapsed_milliseconds(started_at)
        decode_ms = elapsed_ms - ttft_ms if ttft_ms is not None else None
        return RequestResult(
            worker=-1,
            iteration=-1,
            status_code=status_code,
            started_at=started_at,
            elapsed_ms=elapsed_ms,
            ttft_ms=ttft_ms,
            decode_ms=decode_ms,
            prompt_tokens=prompt_tokens,
            output_tokens=output_tokens,
            finish_reason=finish_reason,
            error=None,
        )

    def read_json_response(
        self,
        status_code: int,
        started_at: float,
        response: Any,
    ) -> RequestResult:
        body = json.load(response)
        usage = body.get("usage") or {}
        choices = body.get("choices") or []
        finish_reason = choices[0].get("finish_reason") if choices else None
        elapsed_ms = elapsed_milliseconds(started_at)
        return RequestResult(
            worker=-1,
            iteration=-1,
            status_code=status_code,
            started_at=started_at,
            elapsed_ms=elapsed_ms,
            ttft_ms=None,
            decode_ms=None,
            prompt_tokens=int_or_none(usage.get("prompt_tokens")),
            output_tokens=int_or_none(usage.get("completion_tokens")),
            finish_reason=finish_reason,
            error=None,
        )

    def error_result(
        self,
        started_at: float,
        status_code: Optional[int],
        message: str,
    ) -> RequestResult:
        return RequestResult(
            worker=-1,
            iteration=-1,
            status_code=status_code,
            started_at=started_at,
            elapsed_ms=elapsed_milliseconds(started_at),
            ttft_ms=None,
            decode_ms=None,
            prompt_tokens=None,
            output_tokens=None,
            finish_reason=None,
            error=message[:400],
        )

    @staticmethod
    def read_http_error(error: urllib.error.HTTPError) -> str:
        body = error.read(400).decode("utf-8", errors="replace")
        return body.strip() or str(error)


class MetricsReader:
    def __init__(self, client: LlamaClient):
        self.client = client
        self.available = False

    def probe(self) -> bool:
        try:
            self.client.get_text("/metrics")
            self.available = True
            return True
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            return False

    def snapshot(self) -> Dict[str, float]:
        if not self.available:
            return {}
        try:
            text = self.client.get_text("/metrics")
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            return {}
        metrics: Dict[str, float] = {}
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue
            try:
                if "{" in line:
                    name, value_text = line.split("{", 1)
                    value_text = value_text.rsplit("}", 1)[-1]
                else:
                    name, value_text = line.rsplit(None, 1)
                metrics[name] = float(value_text)
            except (ValueError, IndexError):
                continue
        return metrics


class HostSampler:
    def __init__(self, server_pid: Optional[int], sample_interval_seconds: float):
        self.server_pid = server_pid
        self.sample_interval_seconds = sample_interval_seconds
        self.samples: List[HostSample] = []
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="m5-host-sampler", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)

    def run(self) -> None:
        while not self.stop_event.wait(self.sample_interval_seconds):
            sample = self.sample_once()
            with self.lock:
                self.samples.append(sample)

    def sample_once(self) -> HostSample:
        top_output = run_command(
            ["top", "-l", "1", "-stats", "pid,command,cpu,mem,power"],
            timeout=5,
        )
        process_metrics = parse_top_process(top_output, self.server_pid)
        system_metrics = parse_top_system(top_output)

        ps_metrics: Dict[str, Optional[float]] = {}
        if self.server_pid:
            ps_output = run_command(
                [
                    "ps",
                    "-p",
                    str(self.server_pid),
                    "-o",
                    "%cpu=,rss=,vsz=,%mem=",
                ],
                timeout=2,
            )
            ps_metrics = parse_ps_process(ps_output)

        return HostSample(
            timestamp=time.time(),
            process_cpu_percent=process_metrics.get("cpu_percent"),
            process_cpu_lifetime_percent=ps_metrics.get("cpu_lifetime_percent"),
            process_rss_mb=ps_metrics.get("rss_mb"),
            process_virtual_mb=ps_metrics.get("virtual_mb"),
            process_memory_percent=ps_metrics.get("memory_percent"),
            process_power=process_metrics.get("power"),
            system_user_cpu_percent=system_metrics.get("user_cpu_percent"),
            system_system_cpu_percent=system_metrics.get("system_cpu_percent"),
            system_idle_cpu_percent=system_metrics.get("idle_cpu_percent"),
            load_1m=system_metrics.get("load_1m"),
            load_5m=system_metrics.get("load_5m"),
            load_15m=system_metrics.get("load_15m"),
            memory_pressure_percent=memory_pressure_percent(),
            phys_memory_used_mb=system_metrics.get("used_mb"),
            phys_memory_wired_mb=system_metrics.get("wired_mb"),
            phys_memory_compressed_mb=system_metrics.get("compressed_mb"),
            phys_memory_unused_mb=system_metrics.get("unused_mb"),
            swapins_total=system_metrics.get("swapins_total"),
            swapouts_total=system_metrics.get("swapouts_total"),
        )

    def samples_between(self, start_time: float, end_time: float) -> List[HostSample]:
        with self.lock:
            return [
                sample
                for sample in self.samples
                if start_time <= sample.timestamp <= end_time
            ]


class PowerMetricsRecorder:
    def __init__(self, output_path: Path, sample_interval_seconds: float):
        self.output_path = output_path
        self.sample_interval_ms = max(1000, int(sample_interval_seconds * 1000))
        self.process: Optional[subprocess.Popen] = None
        self.stdout_file: Optional[Any] = None
        self.stderr_file: Optional[Any] = None

    def start(self) -> None:
        self.stdout_file = self.output_path.open("wb")
        self.stderr_file = self.output_path.with_suffix(".stderr.log").open("wb")
        command = [
            "sudo",
            "-n",
            "powermetrics",
            "--samplers",
            "cpu_power,gpu_power,ane_power,thermal",
            "--format",
            "text",
            "-b",
            "1",
            "-i",
            str(self.sample_interval_ms),
            "-n",
            "-1",
        ]
        try:
            self.process = subprocess.Popen(
                command,
                stdout=self.stdout_file,
                stderr=self.stderr_file,
                start_new_session=True,
            )
        except OSError as error:
            self.process = None
            print(f"[warn] Could not start powermetrics: {error}")
            return

        time.sleep(1)
        if self.process.poll() is not None:
            print(
                "[warn] powermetrics exited immediately. "
                "Run `sudo -v` first or grant the benchmark user passwordless sudo."
            )
            self.close_streams()
            self.process = None
            return
    def stop(self) -> None:
        if not self.process or self.process.poll() is not None:
            self.close_streams()
            return
        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        self.close_streams()

    def close_streams(self) -> None:
        for stream in (self.stdout_file, self.stderr_file):
            if stream:
                stream.close()
        self.stdout_file = None
        self.stderr_file = None

    def parse(self) -> Dict[str, Any]:
        if not self.output_path.exists():
            return {"available": False}
        raw_output = self.output_path.read_text(encoding="utf-8", errors="replace")
        return parse_powermetrics(raw_output)


def build_prompt(approximate_words: int) -> str:
    paragraphs: List[str] = []
    words = 0
    while words < approximate_words:
        paragraphs.append(PROMPT_PARAGRAPH)
        words += len(PROMPT_PARAGRAPH.split())
    return (
        "\n\n".join(paragraphs)
        + "\n\nProvide a detailed, point-by-point analysis of these performance "
        + "considerations and continue until the response is complete."
    )


def build_payload(
    model: str,
    prompt: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    seed: int,
    stream: bool,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "seed": seed,
        "stream": stream,
    }
    if stream:
        payload["stream_options"] = {"include_usage": True}
    return payload


def run_phase(
    client: LlamaClient,
    metrics_reader: MetricsReader,
    host_sampler: Optional[HostSampler],
    path: str,
    payload: Dict[str, Any],
    concurrency: int,
    iterations: int,
) -> Tuple[List[RequestResult], Dict[str, Any]]:
    requests = [
        (worker, iteration)
        for worker in range(concurrency)
        for iteration in range(1, iterations + 1)
    ]
    metrics_before = metrics_reader.snapshot()
    phase_start = time.time()
    results: List[RequestResult] = []

    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="llama-bench") as executor:
        futures = {
            executor.submit(client.chat_completion, path, payload): (worker, iteration)
            for worker, iteration in requests
        }
        for future in as_completed(futures):
            worker, iteration = futures[future]
            result = future.result()
            results.append(
                RequestResult(
                    worker=worker,
                    iteration=iteration,
                    status_code=result.status_code,
                    started_at=result.started_at,
                    elapsed_ms=result.elapsed_ms,
                    ttft_ms=result.ttft_ms,
                    decode_ms=result.decode_ms,
                    prompt_tokens=result.prompt_tokens,
                    output_tokens=result.output_tokens,
                    finish_reason=result.finish_reason,
                    error=result.error,
                )
            )

    phase_end = time.time()
    metrics_after = metrics_reader.snapshot()
    host_samples = (
        host_sampler.samples_between(phase_start, phase_end)
        if host_sampler
        else []
    )
    return results, build_phase_summary(
        concurrency,
        results,
        phase_end - phase_start,
        metrics_before,
        metrics_after,
        host_samples,
    )


def build_phase_summary(
    concurrency: int,
    results: Sequence[RequestResult],
    wall_seconds: float,
    metrics_before: Dict[str, float],
    metrics_after: Dict[str, float],
    host_samples: Sequence[HostSample],
) -> Dict[str, Any]:
    successful = [
        result for result in results if result.error is None and result.status_code == 200
    ]
    ttfts = values_or_none(result.ttft_ms for result in successful)
    e2e_latencies = values_or_none(result.elapsed_ms for result in successful)
    decode_rates = [
        tokens_per_second(result.output_tokens, result.decode_ms)
        for result in successful
        if result.output_tokens and result.decode_ms
    ]
    total_tokens = sum(
        (result.prompt_tokens or 0) + (result.output_tokens or 0)
        for result in successful
    )

    prompt_tokens_delta = metric_delta(
        metrics_before,
        metrics_after,
        "llamacpp:prompt_tokens_total",
    )
    prompt_seconds_delta = metric_delta(
        metrics_before,
        metrics_after,
        "llamacpp:prompt_seconds_total",
    )
    generated_tokens_delta = metric_delta(
        metrics_before,
        metrics_after,
        "llamacpp:tokens_predicted_total",
    )
    generated_seconds_delta = metric_delta(
        metrics_before,
        metrics_after,
        "llamacpp:tokens_predicted_seconds_total",
    )

    return {
        "concurrency": concurrency,
        "wall_seconds": round(wall_seconds, 2),
        "requests": len(results),
        "successful": len(successful),
        "error_rate_percent": round(
            (len(results) - len(successful)) * 100.0 / max(len(results), 1),
            2,
        ),
        "requests_per_second": round(len(successful) / wall_seconds, 3)
        if wall_seconds > 0
        else 0,
        "tokens_per_second": round(total_tokens / wall_seconds, 3)
        if wall_seconds > 0
        else 0,
        "ttft_ms": percentile_summary(ttfts),
        "e2e_ms": percentile_summary(e2e_latencies),
        "decode_tokens_per_second": percentile_summary(decode_rates),
        "average_prompt_tokens": round(mean([r.prompt_tokens for r in successful]), 1)
        if successful and all(r.prompt_tokens is not None for r in successful)
        else None,
        "average_output_tokens": round(mean([r.output_tokens for r in successful]), 1)
        if successful and all(r.output_tokens is not None for r in successful)
        else None,
        "metrics_prefill_tokens_per_second": ratio_or_none(
            prompt_tokens_delta,
            prompt_seconds_delta,
        ),
        "metrics_decode_tokens_per_second": ratio_or_none(
            generated_tokens_delta,
            generated_seconds_delta,
        ),
        "host": host_summary(host_samples),
    }


def host_summary(samples: Sequence[HostSample]) -> Dict[str, Any]:
    if not samples:
        return {"samples": 0}
    numeric_columns = [
        "process_cpu_percent",
        "process_rss_mb",
        "system_user_cpu_percent",
        "system_system_cpu_percent",
        "system_idle_cpu_percent",
        "load_1m",
        "memory_pressure_percent",
        "phys_memory_used_mb",
        "phys_memory_wired_mb",
        "phys_memory_compressed_mb",
    ]
    summary: Dict[str, Any] = {"samples": len(samples)}
    for column in numeric_columns:
        values = values_or_none(getattr(sample, column) for sample in samples)
        if values:
            summary[column] = {
                "mean": round(mean(values), 2),
                "max": round(max(values), 2),
            }
    return summary


def percentile_summary(values: Sequence[float]) -> Dict[str, Optional[float]]:
    if not values:
        return {"p50": None, "p90": None, "p95": None, "p99": None}
    return {
        "p50": round(percentile(values, 50), 3),
        "p90": round(percentile(values, 90), 3),
        "p95": round(percentile(values, 95), 3),
        "p99": round(percentile(values, 99), 3),
    }


def metric_delta(
    before: Dict[str, float],
    after: Dict[str, float],
    name: str,
) -> Optional[float]:
    if name not in before or name not in after:
        return None
    return max(after[name] - before[name], 0)


def ratio_or_none(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return round(numerator / denominator, 3)


def tokens_per_second(tokens: Optional[int], milliseconds: Optional[float]) -> Optional[float]:
    if tokens is None or milliseconds is None or milliseconds <= 0:
        return None
    return tokens * 1000.0 / milliseconds


def add_optional(left: Optional[int], right: Optional[int]) -> Optional[int]:
    if left is None or right is None:
        return None
    return left + right


def round_optional(value: Optional[float]) -> Optional[float]:
    return round(value, 3) if value is not None else None


def values_or_none(values: Iterable[Optional[float]]) -> List[float]:
    return [value for value in values if value is not None]


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: Sequence[float], percentile_value: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = (len(ordered) - 1) * percentile_value / 100.0
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    weight = index - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def elapsed_milliseconds(started_at: float) -> float:
    return (time.monotonic() - started_at) * 1000.0


def int_or_none(value: Any) -> Optional[int]:
    return int(value) if value is not None else None


def run_command(command: Sequence[str], timeout: float) -> str:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return completed.stdout
    except (subprocess.TimeoutExpired, OSError):
        return ""


def parse_top_process(output: str, server_pid: Optional[int]) -> Dict[str, Optional[float]]:
    if not server_pid:
        return {}
    pattern = re.compile(rf"^\s*{server_pid}\s+")
    for line in output.splitlines():
        if not pattern.match(line):
            continue
        tail = line.strip().split()[1:]
        if len(tail) < 3:
            continue
        return {
            "cpu_percent": parse_float(tail[-3]),
            "memory_percent": parse_float(tail[-2].rstrip("%")),
            "power": parse_float(tail[-1]),
        }
    return {}


def parse_top_system(output: str) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    cpu_match = re.search(
        r"CPU usage:\s*([0-9.]+)% user,\s*([0-9.]+)% sys,\s*([0-9.]+)% idle",
        output,
    )
    if cpu_match:
        summary["user_cpu_percent"] = float(cpu_match.group(1))
        summary["system_cpu_percent"] = float(cpu_match.group(2))
        summary["idle_cpu_percent"] = float(cpu_match.group(3))

    load_match = re.search(
        r"Load Avg:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)",
        output,
    )
    if load_match:
        summary["load_1m"] = float(load_match.group(1))
        summary["load_5m"] = float(load_match.group(2))
        summary["load_15m"] = float(load_match.group(3))

    memory_match = re.search(
        r"PhysMem:\s*([0-9.]+[KMG]) used "
        r"\(([0-9.]+[KMG]) wired, ([0-9.]+[KMG]) compressor\), "
        r"([0-9.]+[KMG]) unused",
        output,
    )
    if memory_match:
        summary["used_mb"] = parse_size_to_mb(memory_match.group(1))
        summary["wired_mb"] = parse_size_to_mb(memory_match.group(2))
        summary["compressed_mb"] = parse_size_to_mb(memory_match.group(3))
        summary["unused_mb"] = parse_size_to_mb(memory_match.group(4))

    swap_match = re.search(
        r"(\d+)\((\d+)\) swapins, (\d+)\((\d+)\) swapouts",
        output,
    )
    if swap_match:
        summary["swapins_total"] = int(swap_match.group(1))
        summary["swapouts_total"] = int(swap_match.group(3))

    return summary


def parse_ps_process(output: str) -> Dict[str, Optional[float]]:
    parts = output.split()
    if len(parts) < 4:
        return {}
    try:
        return {
            "cpu_lifetime_percent": float(parts[0]),
            "rss_mb": float(parts[1]) / 1024.0,
            "virtual_mb": float(parts[2]) / 1024.0 / 1024.0,
            "memory_percent": float(parts[3]),
        }
    except ValueError:
        return {}


def memory_pressure_percent() -> Optional[float]:
    output = run_command(["memory_pressure", "-Q"], timeout=3)
    match = re.search(r"System-wide memory free percentage:\s*(\d+)%", output)
    if not match:
        return None
    return round(100.0 - float(match.group(1)), 1)


def parse_float(value: str) -> Optional[float]:
    try:
        return float(value)
    except ValueError:
        return None


def parse_size_to_mb(value: str) -> float:
    match = re.fullmatch(r"([0-9.]+)([KMG])", value)
    if not match:
        return 0.0
    multipliers = {"K": 1 / 1024.0, "M": 1.0, "G": 1024.0}
    return float(match.group(1)) * multipliers[match.group(2)]


def parse_powermetrics(raw_output: str) -> Dict[str, Any]:
    patterns = {
        "combined_power_mw": re.compile(
            r"Combined Power \(CPU \+ GPU \+ ANE\):\s*([0-9.]+)\s*mW"
        ),
        "cpu_power_mw": re.compile(r"CPU Power:\s*([0-9.]+)\s*mW"),
        "gpu_power_mw": re.compile(r"GPU Power:\s*([0-9.]+)\s*mW"),
        "ane_power_mw": re.compile(r"ANE Power:\s*([0-9.]+)\s*mW"),
        "dram_power_mw": re.compile(r"DRAM Power:\s*([0-9.]+)\s*mW"),
        "gpu_active_residency_percent": re.compile(
            r"GPU HW active residency:\s*([0-9.]+)%"
        ),
        "cpu_die_temperature_c": re.compile(
            r"CPU die temperature:\s*([0-9.]+)\s*C"
        ),
        "gpu_die_temperature_c": re.compile(
            r"GPU die temperature:\s*([0-9.]+)\s*C"
        ),
    }
    values: Dict[str, List[float]] = {}
    for line in raw_output.splitlines():
        for name, pattern in patterns.items():
            match = pattern.search(line)
            if match:
                values.setdefault(name, []).append(float(match.group(1)))

    if not values:
        return {"available": True, "parsed": False}
    return {
        "available": True,
        "parsed": True,
        **{
            name: {
                "mean": round(mean(samples), 2),
                "max": round(max(samples), 2),
            }
            for name, samples in values.items()
        },
    }


def find_server_pid(port: int) -> Optional[int]:
    output = run_command(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"],
        timeout=5,
    )
    pids = [
        int(line[1:])
        for line in output.splitlines()
        if line.startswith("p") and line[1:].isdigit()
    ]
    return pids[-1] if pids else None


def collect_system_info(server_pid: Optional[int]) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "macos_version": platform.mac_ver()[0],
        "server_pid": server_pid,
    }
    sysctl_keys = {
        "model": "hw.model",
        "cpu_brand": "machdep.cpu.brand_string",
        "total_memory_bytes": "hw.memsize",
        "cpu_count": "hw.ncpu",
        "performance_cpu_count": "hw.perflevel0.physicalcpu",
        "efficiency_cpu_count": "hw.perflevel1.physicalcpu",
    }
    for output_name, sysctl_key in sysctl_keys.items():
        value = run_command(["sysctl", "-n", sysctl_key], timeout=3).strip()
        if value:
            info[output_name] = value
    return info


def first_model_id(models_payload: Dict[str, Any]) -> Optional[str]:
    models = models_payload.get("data") or []
    if not models or not isinstance(models[0], dict):
        return None
    return models[0].get("id")


def write_csv(path: Path, columns: Sequence[str], rows: Sequence[Dict[str, Any]]) -> None:
    with path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(columns), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def print_summary(summaries: Sequence[Dict[str, Any]]) -> None:
    print("\nBenchmark summary")
    print(
        f"{'C':>2} {'Req':>4} {'Err%':>6} "
        f"{'TTFT p50':>9} {'TTFT p90':>9} {'TTFT p95':>9} "
        f"{'E2E p50':>8} {'E2E p95':>8} "
        f"{'Out t/s':>8} {'PF t/s':>8} {'Dec t/s':>8} {'Req/s':>7}"
    )
    for summary in summaries:
        ttft = summary["ttft_ms"]
        e2e = summary["e2e_ms"]
        decode = summary["decode_tokens_per_second"]
        print(
            f"{summary['concurrency']:>2} "
            f"{summary['requests']:>4} "
            f"{summary['error_rate_percent']:>6.1f} "
            f"{display_ms(ttft['p50']):>9} "
            f"{display_ms(ttft['p90']):>9} "
            f"{display_ms(ttft['p95']):>9} "
            f"{display_ms(e2e['p50']):>8} "
            f"{display_ms(e2e['p95']):>8} "
            f"{display_number(decode['p50']):>8} "
            f"{display_number(summary['metrics_prefill_tokens_per_second']):>8} "
            f"{display_number(summary['metrics_decode_tokens_per_second']):>8} "
            f"{summary['requests_per_second']:>7.3f}"
        )


def display_ms(value: Optional[float]) -> str:
    return f"{value:.0f}" if value is not None else "-"


def display_number(value: Optional[float]) -> str:
    return f"{value:.1f}" if value is not None else "-"


def probe_server(
    client: LlamaClient,
    metrics_reader: MetricsReader,
) -> Tuple[Dict[str, Any], bool]:
    health: Dict[str, Any] = {}
    try:
        health = client.get_json("/health")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as error:
        raise RuntimeError(
            f"llama-server is not healthy at {client.base_url}: {error}"
        )

    props: Dict[str, Any] = {}
    try:
        props = client.get_json("/props")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as error:
        print(f"[warn] /props is unavailable: {error}")

    models: Dict[str, Any] = {}
    try:
        models = client.get_json("/models")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as error:
        print(f"[warn] /models is unavailable: {error}")

    metrics_available = metrics_reader.probe()
    if not metrics_available:
        print(
            "[warn] /metrics is unavailable. Add --metrics to llama-server for "
            "separate prefill and decode timings."
        )
    return {
        "health": health,
        "props": props,
        "models": models,
        "metrics_enabled": metrics_available,
    }, metrics_available


def parse_concurrency(value: str) -> List[int]:
    levels = []
    for item in value.split(","):
        level = int(item)
        if level <= 0:
            raise argparse.ArgumentTypeError("concurrency values must be positive")
        levels.append(level)
    if not levels:
        raise argparse.ArgumentTypeError("at least one concurrency value is required")
    return sorted(set(levels))


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark a local llama-server on Apple silicon.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--url", default=DEFAULT_BASE_URL, help="llama-server base URL")
    parser.add_argument(
        "--api-path",
        default=DEFAULT_CHAT_PATH,
        help="chat completions endpoint",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="model name sent in requests; defaults to the first model in /models",
    )
    parser.add_argument(
        "--concurrency",
        type=parse_concurrency,
        default=[1, 2, 4, 8],
        help="comma-separated concurrency levels",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=3,
        help="requests sent per worker at each concurrency level",
    )
    parser.add_argument("--warmup-requests", type=int, default=1, help="warmup requests")
    parser.add_argument("--max-tokens", type=int, default=256, help="max output tokens")
    parser.add_argument(
        "--prompt-words",
        type=int,
        default=256,
        help="approximate prompt size in English words",
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        default=DEFAULT_PROMPT_FILE,
        help="fixed prompt text file",
    )
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout", type=int, default=300, help="request timeout in seconds")
    parser.add_argument(
        "--no-stream",
        action="store_true",
        help="use non-streaming requests; TTFT is unavailable",
    )
    parser.add_argument(
        "--no-host-metrics",
        action="store_true",
        help="disable macOS CPU, memory, and pressure sampling",
    )
    parser.add_argument(
        "--powermetrics",
        action="store_true",
        help="collect power/thermal samples; requires passwordless sudo",
    )
    parser.add_argument(
        "--sample-interval",
        type=float,
        default=2.0,
        help="host/powermetrics sample interval in seconds",
    )
    parser.add_argument("--server-pid", type=int, help="override llama-server process id")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(DEFAULT_OUTPUT_ROOT),
        help="parent directory for result files",
    )
    return parser


def validate_arguments(args: argparse.Namespace) -> None:
    if args.iterations <= 0:
        raise SystemExit("--iterations must be positive")
    if args.max_tokens <= 0:
        raise SystemExit("--max-tokens must be positive")
    if args.prompt_words <= 0:
        raise SystemExit("--prompt-words must be positive")
    if args.sample_interval < 1:
        raise SystemExit("--sample-interval must be at least 1 second")
    if args.timeout <= 0:
        raise SystemExit("--timeout must be positive")
    if args.powermetrics and not sys.platform == "darwin":
        raise SystemExit("--powermetrics is only supported on macOS")


def main() -> int:
    args = build_argument_parser().parse_args()
    validate_arguments(args)

    client = LlamaClient(args.url, args.timeout)
    metrics_reader = MetricsReader(client)
    server_info, _ = probe_server(client, metrics_reader)
    print(f"llama-server is healthy at {args.url}")

    parsed_url = urllib.request.urlparse(args.url)
    server_pid = args.server_pid or find_server_pid(parsed_url.port or 80)
    if server_pid:
        print(f"Monitoring llama-server pid {server_pid}")
    else:
        print("[warn] Could not identify llama-server pid; process metrics are disabled.")

    output_root = args.output_dir.resolve()
    output_dir = output_root / datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Writing results to {output_dir}")

    if args.prompt_file.exists():
        prompt = args.prompt_file.read_text(encoding="utf-8")
    else:
        print(
            f"[warn] Prompt file {args.prompt_file} is missing; "
            "using the built-in generated prompt."
        )
        prompt = build_prompt(args.prompt_words)
    (output_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    request_model = args.model or first_model_id(server_info["models"]) or "local-model"
    payload = build_payload(
        model=request_model,
        prompt=prompt,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        seed=args.seed,
        stream=not args.no_stream,
    )

    host_sampler: Optional[HostSampler] = None
    if not args.no_host_metrics and sys.platform == "darwin":
        host_sampler = HostSampler(server_pid, args.sample_interval)
        host_sampler.start()

    power_recorder: Optional[PowerMetricsRecorder] = None
    if args.powermetrics:
        power_recorder = PowerMetricsRecorder(
            output_dir / "powermetrics.log",
            args.sample_interval,
        )
        power_recorder.start()

    try:
        for index in range(args.warmup_requests):
            print(f"Warmup request {index + 1}/{args.warmup_requests}")
            client.chat_completion(args.api_path, payload)

        all_request_rows: List[Dict[str, Any]] = []
        summaries: List[Dict[str, Any]] = []
        for concurrency in args.concurrency:
            print(
                f"Running concurrency={concurrency}, "
                f"{concurrency * args.iterations} requests"
            )
            results, summary = run_phase(
                client=client,
                metrics_reader=metrics_reader,
                host_sampler=host_sampler,
                path=args.api_path,
                payload=payload,
                concurrency=concurrency,
                iterations=args.iterations,
            )
            all_request_rows.extend(
                result.as_row(concurrency) for result in results
            )
            summaries.append(summary)

        report: Dict[str, Any] = {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "command_line": sys.argv,
            "configuration": {
                "url": args.url,
                "api_path": args.api_path,
                "model": request_model,
                "concurrency_levels": args.concurrency,
                "iterations_per_worker": args.iterations,
                "warmup_requests": args.warmup_requests,
                "max_tokens": args.max_tokens,
                "prompt_words": args.prompt_words,
                "prompt_file": str(args.prompt_file),
                "prompt_characters": len(prompt),
                "temperature": args.temperature,
                "top_p": args.top_p,
                "seed": args.seed,
                "stream": not args.no_stream,
            },
            "system": collect_system_info(server_pid),
            "server": server_info,
            "summaries": summaries,
        }
        if power_recorder:
            power_recorder.stop()
            report["powermetrics"] = power_recorder.parse()

        write_csv(
            output_dir / "requests.csv",
            REQUEST_COLUMNS,
            all_request_rows,
        )
        if host_sampler:
            write_csv(
                output_dir / "host_metrics.csv",
                HOST_COLUMNS,
                [sample.as_row() for sample in host_sampler.samples],
            )
        with (output_dir / "summary.json").open("w") as summary_file:
            json.dump(report, summary_file, indent=2, sort_keys=True)

        print_summary(summaries)
        print(f"\nFull results: {output_dir}")
        return 0
    finally:
        if host_sampler:
            host_sampler.stop()
        if power_recorder and power_recorder.process:
            power_recorder.stop()


if __name__ == "__main__":
    try:
        exit_code = main()
    except KeyboardInterrupt:
        print("\nBenchmark interrupted.", file=sys.stderr)
        exit_code = 130
    except RuntimeError as error:
        print(f"[error] {error}", file=sys.stderr)
        exit_code = 1
    raise SystemExit(exit_code)
