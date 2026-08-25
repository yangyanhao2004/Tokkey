"""Command-line entry point for the bundled Tokiie gateway helper."""

from __future__ import annotations

import argparse
import os

import uvicorn

from .app import create_app


def parse_args() -> argparse.Namespace:
    """Parse the intentionally small process-launch contract owned by Swift."""
    parser = argparse.ArgumentParser(description="Run the local Tokiie LiteLLM SDK gateway.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4000)
    return parser.parse_args()


def main() -> None:
    """Start one loopback-only Uvicorn worker with proxy headers disabled."""
    args = parse_args()
    master_key = os.environ.get("AMIS_GATEWAY_MASTER_KEY", "")
    if not master_key:
        raise SystemExit("AMIS_GATEWAY_MASTER_KEY is required")
    instance_id = os.environ.get("AMIS_GATEWAY_INSTANCE_ID", "")
    if not instance_id:
        raise SystemExit("AMIS_GATEWAY_INSTANCE_ID is required")
    uvicorn.run(
        create_app(master_key=master_key, instance_id=instance_id),
        host=args.host,
        port=args.port,
        proxy_headers=False,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
