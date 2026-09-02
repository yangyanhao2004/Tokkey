# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec that freezes the gateway into a self-contained directory.

Built as a onedir bundle rather than onefile: onefile unpacks the whole tree to
a temporary directory on every launch, which the supervisor's readiness budget
would pay for at each app start and each crash restart. A directory bundle also
stays signable and notarizable as part of the surrounding app.
"""

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# LiteLLM resolves providers, cost maps and tokenizers by name at call time, so
# static analysis sees almost none of them. Everything under the package is
# collected rather than enumerated: the provider list moves with every upstream
# bump, and a missing one surfaces only as a runtime failure on the one model
# that needs it.
LITELLM_HIDDEN_IMPORTS = collect_submodules("litellm")
# Bundled JSON: model_prices_and_context_window_backup.json (the map that
# LITELLM_LOCAL_MODEL_COST_MAP forces LiteLLM to read instead of fetching from
# GitHub at startup), the Anthropic tokenizer, and the provider/policy backups.
LITELLM_DATA_FILES = collect_data_files("litellm", include_py_files=False)

# Uvicorn picks its event loop, HTTP parser and websocket implementation from
# strings at startup, and Starlette/FastAPI pull parts of their stack lazily.
SERVER_HIDDEN_IMPORTS = [
    *collect_submodules("uvicorn"),
    "starlette.routing",
    "starlette.responses",
]

# tiktoken registers its encodings through the `tiktoken_ext` namespace package,
# which is discovered by scanning that namespace at runtime and is therefore
# invisible to the analyzer.
TOKENIZER_HIDDEN_IMPORTS = [
    *collect_submodules("tiktoken_ext"),
    "tiktoken_ext.openai_public",
    "tiktoken",
]
TOKENIZER_DATA_FILES = collect_data_files("tiktoken_ext", include_py_files=False)

# httpx[socks] reaches its SOCKS transport through an optional import, used only
# when a user has configured a proxy for a public custom provider.
TRANSPORT_HIDDEN_IMPORTS = ["socksio", "httpx", "h11", "certifi"]

# Frameworks that LiteLLM only touches behind optional-import guards. Excluding
# them keeps the bundle near the size of the interpreter tree it replaces; each
# is unreachable on this runtime's SDK-only path.
EXCLUDED_MODULES = [
    "IPython",
    "PIL",
    "PyQt5",
    "PySide2",
    "matplotlib",
    "notebook",
    "numpy",
    "pandas",
    "scipy",
    "sklearn",
    "tkinter",
    "torch",
    "transformers",
]

analysis = Analysis(
    ["entry.py"],
    pathex=["../src"],
    binaries=[],
    datas=[*LITELLM_DATA_FILES, *TOKENIZER_DATA_FILES],
    hiddenimports=[
        *LITELLM_HIDDEN_IMPORTS,
        *SERVER_HIDDEN_IMPORTS,
        *TOKENIZER_HIDDEN_IMPORTS,
        *TRANSPORT_HIDDEN_IMPORTS,
        "amis_gateway.main",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDED_MODULES,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="amis-gateway",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is off: a compressed binary inside a signed app bundle trips Gatekeeper
    # and buys nothing once the tree is already inside a compressed installer.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="amis-gateway",
)
