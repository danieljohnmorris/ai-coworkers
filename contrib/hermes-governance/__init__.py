"""hermes-governance plugin — runtime enforcement of BOUNDARIES.md.

Ports the governance layer from ai-coworkers
(``src/runtime/boundaries.ts``) into a Hermes plugin. The plugin
registers ``pre_tool_call`` (block mode) and ``on_session_start`` and
denies any tool call that would violate a rule declared in a plain
BOUNDARIES.md file.

Discovery order for BOUNDARIES.md:
1. ``$HERMES_HOME/BOUNDARIES.md``
2. ``./BOUNDARIES.md`` (current working directory)
3. ``$HOME/.hermes/BOUNDARIES.md``

If no file is found, the plugin logs a warning and registers as a
no-op — Hermes must not crash because a governance file is missing.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

try:  # relative import when Hermes loads us as a package
    from . import boundaries_parser as bp
except ImportError:  # standalone import (dashed dir name, tests, etc.)
    import boundaries_parser as bp  # type: ignore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Module state
# ---------------------------------------------------------------------------

_STATE_LOCK = threading.Lock()
_RULESET: Optional[bp.Ruleset] = None
_COUNTER = bp.ResourceCounter()
_LOG_DIR: Optional[Path] = None
_LOAD_ATTEMPTED = False


_SECRET_KEY_RE = re.compile(
    r"(token|secret|password|api[_-]?key|bearer|authorization)", re.IGNORECASE
)


def _hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".hermes"


def _candidate_paths() -> list[Path]:
    home = _hermes_home()
    return [
        home / "BOUNDARIES.md",
        Path.cwd() / "BOUNDARIES.md",
        Path.home() / ".hermes" / "BOUNDARIES.md",
    ]


def _find_boundaries() -> Optional[Path]:
    seen: set[str] = set()
    for p in _candidate_paths():
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        if p.exists() and p.is_file():
            return p
    return None


def _ensure_loaded() -> bp.Ruleset:
    """Lazy-load the ruleset on first use. Idempotent, thread-safe."""
    global _RULESET, _LOG_DIR, _LOAD_ATTEMPTED
    with _STATE_LOCK:
        if _RULESET is not None:
            return _RULESET
        _LOAD_ATTEMPTED = True
        path = _find_boundaries()
        if path is None:
            logger.warning(
                "hermes-governance: no BOUNDARIES.md found in %s — plugin is a no-op",
                ", ".join(str(p) for p in _candidate_paths()),
            )
            _RULESET = bp.Ruleset()
        else:
            _RULESET = bp.load_boundaries(path)
            logger.info(
                "hermes-governance: loaded %d rule(s) from %s",
                _RULESET.rule_count(),
                path,
            )
        _LOG_DIR = _hermes_home() / "hermes-governance"
        try:
            _LOG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning(
                "hermes-governance: cannot create log dir %s: %s", _LOG_DIR, exc
            )
            _LOG_DIR = None
        return _RULESET


def _redact(args: Any) -> Any:
    """Return a copy of args with likely-secret values masked."""
    if isinstance(args, dict):
        return {
            k: ("<redacted>" if _SECRET_KEY_RE.search(k) else _redact(v))
            for k, v in args.items()
        }
    if isinstance(args, list):
        return [_redact(x) for x in args]
    return args


def _log_block(tool_name: str, args: Any, reason: str) -> None:
    if _LOG_DIR is None:
        return
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool": tool_name,
        "reason": reason,
        "args": _redact(args),
    }
    try:
        with (_LOG_DIR / "blocks.log").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except OSError as exc:
        logger.debug("hermes-governance: failed to write blocks.log: %s", exc)


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def _on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    **_: Any,
) -> Optional[Dict[str, str]]:
    """Block a tool call that would violate BOUNDARIES.md.

    Signature and return shape mirror
    ``plugins/security-guidance/__init__.py:_on_pre_tool_call`` — a
    block verdict is a dict ``{"action": "block", "message": "..."}``;
    ``None`` allows the call.
    """
    rs = _ensure_loaded()
    if rs.is_empty():
        return None

    reason = bp.check_must_not_touch(rs, tool_name, args)
    if reason is None:
        reason = bp.check_field_allowlist(rs, tool_name, args)
    warning: Optional[str] = None
    if reason is None:
        warning, block = bp.check_resource_limits(rs, _COUNTER, tool_name)
        if block is not None:
            reason = block

    if warning:
        logger.warning("hermes-governance: %s", warning)

    if reason is None:
        return None

    _log_block(tool_name, args, reason)
    return {
        "action": "block",
        "message": f"hermes-governance blocked this call: {reason}",
    }


def _on_session_start(**_: Any) -> None:
    rs = _ensure_loaded()
    path = rs.source_path or "<none>"
    logger.info(
        "[hermes-governance] loaded %d rules from %s", rs.rule_count(), path
    )


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("on_session_start", _on_session_start)
