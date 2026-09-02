"""PyInstaller entry script for the frozen gateway executable.

PyInstaller freezes a script, not a `-m package.module` invocation, so this
thin wrapper stands in for `python -m amis_gateway.main`. It keeps the
argument contract owned by `amis_gateway.main` untouched: everything after the
executable name is parsed there exactly as it is for the interpreter layout.
"""

from __future__ import annotations

import multiprocessing

from amis_gateway.main import main

if __name__ == "__main__":
    # Required before any other work in a frozen build: without it, a child
    # process spawned by a dependency re-runs this bootstrap and forks the
    # server instead of starting a worker.
    multiprocessing.freeze_support()
    main()
