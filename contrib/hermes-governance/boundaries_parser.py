"""Parse BOUNDARIES.md into a deterministic ruleset.

Port of ``src/runtime/boundaries.ts`` from the ai-coworkers TypeScript
harness. The three rule shapes match the reference implementation:

1. **Must not touch** — bullets under any heading matching
   ``/must not (touch|do|write|call)/i`` (or, more loosely, headings
   mentioning ``not touch``, ``never``, ``forbidden``, ``do not``).
   Each bullet is a substring/word-boundary denylist entry checked
   against the tool name AND every string value in the tool's args.

2. **Tool field allowlist** — bullets under a heading matching
   ``/tool field allowlist/i`` (also plain ``/field allowlist/i``),
   formatted as ``- <tool.name>: field1, field2``. For matching tool
   calls, any top-level input key outside the allowlist is blocked.

3. **Resource limits** — bullets like ``Max LLM calls per day: N``.
   Session-local counter tracking; warning as the count approaches
   and a block once N is exceeded.

The parser is intentionally tolerant: unknown headings, malformed
bullets, and commented-out lines (``<!-- ... -->`` or leading ``#``
comment lines that are NOT markdown headings — i.e. inside a fenced
code block) are ignored rather than raising.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# Match a markdown heading line: ``# foo``, ``## foo``, up to ``######``.
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")

# Match a bullet line: ``- foo`` or ``* foo``, capturing the body.
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")

# Match a field-allowlist bullet body: ``<tool.name>: field, field``.
_ALLOWLIST_BODY_RE = re.compile(
    r"^`?([a-z][a-z0-9_.]*)`?\s*:\s*(.+?)\s*$", re.IGNORECASE
)

# Match a resource-limit bullet body: ``Max LLM calls per day: 500``.
# Capture (label, integer).
_RESOURCE_RE = re.compile(
    r"^(?P<label>[A-Za-z][A-Za-z0-9 _\-/]*?)\s*:\s*(?P<n>\d+)\s*$"
)


# Heading classifiers -------------------------------------------------------

_MUST_NOT_RE = re.compile(
    r"(must\s+not\s+(touch|do|write|call)|not\s+touch|never|forbidden|do\s+not)",
    re.IGNORECASE,
)
_FIELD_ALLOWLIST_RE = re.compile(r"(tool\s+)?field\s+allowlist", re.IGNORECASE)
_RESOURCE_HEADING_RE = re.compile(r"resource\s+limits?", re.IGNORECASE)


@dataclass
class Ruleset:
    """Parsed BOUNDARIES.md content."""

    must_not_touch: List[str] = field(default_factory=list)
    # tool_name -> list of allowed top-level keys
    field_allowlist: Dict[str, List[str]] = field(default_factory=dict)
    # limit_key -> integer cap (e.g. {"max_llm_calls_per_day": 500})
    resource_limits: Dict[str, int] = field(default_factory=dict)
    source_path: Optional[str] = None

    def is_empty(self) -> bool:
        return (
            not self.must_not_touch
            and not self.field_allowlist
            and not self.resource_limits
        )

    def rule_count(self) -> int:
        return (
            len(self.must_not_touch)
            + len(self.field_allowlist)
            + len(self.resource_limits)
        )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_boundaries(text: str, source_path: Optional[str] = None) -> Ruleset:
    """Parse a BOUNDARIES.md document into a :class:`Ruleset`.

    Empty input yields an empty ruleset. Malformed sections are skipped
    rather than raised — BOUNDARIES.md is a human-edited artifact and
    the runtime must never crash Hermes over a typo.
    """
    rs = Ruleset(source_path=source_path)
    if not text:
        return rs

    section: Optional[str] = None  # "must_not" | "field_allowlist" | "resource" | None
    in_code_fence = False

    for raw in text.splitlines():
        line = raw.rstrip()

        # Track fenced code blocks — bullets inside a fence are examples,
        # not rules.
        if line.lstrip().startswith("```"):
            in_code_fence = not in_code_fence
            continue
        if in_code_fence:
            continue

        # HTML comments: skip.
        stripped = line.strip()
        if stripped.startswith("<!--"):
            continue

        heading_match = _HEADING_RE.match(line)
        if heading_match:
            title = heading_match.group(1)
            if _FIELD_ALLOWLIST_RE.search(title):
                section = "field_allowlist"
            elif _RESOURCE_HEADING_RE.search(title):
                section = "resource"
            elif _MUST_NOT_RE.search(title):
                section = "must_not"
            else:
                section = None
            continue

        if section is None:
            continue

        bullet = _BULLET_RE.match(line)
        if not bullet:
            continue
        body = bullet.group(1).strip()
        if not body:
            continue

        if section == "must_not":
            # Strip backticks and trailing punctuation.
            entry = body.strip("`").strip()
            if entry:
                rs.must_not_touch.append(entry)
            continue

        if section == "field_allowlist":
            m = _ALLOWLIST_BODY_RE.match(body)
            if not m:
                continue
            tool_name = m.group(1)
            fields = [
                f.strip().strip("`")
                for f in m.group(2).split(",")
                if f.strip()
            ]
            rs.field_allowlist[tool_name] = fields
            continue

        if section == "resource":
            m = _RESOURCE_RE.match(body)
            if not m:
                continue
            label = m.group("label").strip().lower()
            key = re.sub(r"[^a-z0-9]+", "_", label).strip("_")
            try:
                rs.resource_limits[key] = int(m.group("n"))
            except ValueError:
                continue

    return rs


def load_boundaries(path: Path) -> Ruleset:
    """Read *path* and parse it. Non-existent path returns an empty ruleset."""
    if not path or not path.exists():
        return Ruleset(source_path=str(path) if path else None)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return Ruleset(source_path=str(path))
    return parse_boundaries(text, source_path=str(path))


# ---------------------------------------------------------------------------
# Rule evaluation
# ---------------------------------------------------------------------------


def _collect_arg_strings(args: Any) -> List[str]:
    """Flatten every string value in *args* (recursively)."""
    out: List[str] = []

    def walk(v: Any) -> None:
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)

    walk(args)
    return out


def _word_boundary_hit(needle: str, haystack: str) -> bool:
    """Word-boundary match — mirrors the boundaries.ts denylist scan.

    Tokens shorter than 3 chars are treated as literal substring matches
    against the tool name and skipped for the haystack blob to avoid
    over-blocking on common English fragments (matches boundaries.ts).
    """
    if not needle:
        return False
    escaped = re.escape(needle.lower())
    pattern = rf"(^|[^a-z0-9_]){escaped}([^a-z0-9_]|$)"
    return re.search(pattern, haystack, re.IGNORECASE) is not None


def check_must_not_touch(
    rs: Ruleset, tool_name: str, args: Any
) -> Optional[str]:
    """Return a block reason if a must-not-touch entry matches, else None."""
    if not rs.must_not_touch:
        return None
    tool_lc = (tool_name or "").lower()
    try:
        blob = json.dumps(args, default=str).lower()
    except (TypeError, ValueError):
        blob = " ".join(_collect_arg_strings(args)).lower()

    for raw in rs.must_not_touch:
        entry = raw.strip()
        if not entry or len(entry) < 3:
            continue
        entry_lc = entry.lower()
        # Fast path: substring match on tool name (short-circuit).
        if entry_lc in tool_lc:
            return f"tool '{tool_name}' matches forbidden target: {entry}"
        # Word-boundary scan over serialized args.
        if _word_boundary_hit(entry, blob):
            return f"input mentions forbidden target: {entry}"
    return None


def check_field_allowlist(
    rs: Ruleset, tool_name: str, args: Any
) -> Optional[str]:
    """Return a block reason if a top-level arg key is outside the allowlist."""
    allow = rs.field_allowlist.get(tool_name)
    if allow is None:
        return None
    if not isinstance(args, dict):
        return None
    for key in args.keys():
        if key not in allow:
            return f"field '{key}' not in allowlist for {tool_name}"
    return None


# Resource limit tracking ---------------------------------------------------


class ResourceCounter:
    """Session-local counter for the ``Max LLM calls per day`` style caps.

    The POC tracks call counts in memory only — persistence across
    Hermes sessions would require wiring into the host's session store,
    which is out of scope for this proof of concept. Documented in the
    README.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}

    def observe(self, key: str, n: int = 1) -> int:
        self._counts[key] = self._counts.get(key, 0) + n
        return self._counts[key]

    def get(self, key: str) -> int:
        return self._counts.get(key, 0)

    def reset(self, key: Optional[str] = None) -> None:
        if key is None:
            self._counts.clear()
        else:
            self._counts.pop(key, None)


def check_resource_limits(
    rs: Ruleset, counter: ResourceCounter, tool_name: str
) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(warning, block_reason)`` after observing this tool call.

    Only ``max_llm_calls_per_day`` and ``max_llm_calls_per_5h_window``
    are inspected for now (matching the BOUNDARIES.md examples in the
    ai-coworkers repo). All other resource keys parse successfully and
    are made available on ``rs.resource_limits`` for future enforcement.
    """
    warning: Optional[str] = None
    block: Optional[str] = None
    # Best-effort: treat any tool call as one "action" tick. Real per-LLM
    # accounting would hook post_llm_call instead; documented as a gap.
    for key in ("max_llm_calls_per_day", "max_llm_calls_per_5h_window"):
        cap = rs.resource_limits.get(key)
        if cap is None:
            continue
        current = counter.observe(key)
        if current > cap:
            block = (
                f"resource limit exceeded: {key.replace('_', ' ')} "
                f"({current}/{cap})"
            )
            return warning, block
        if current >= max(1, int(cap * 0.9)):
            warning = (
                f"approaching {key.replace('_', ' ')} limit "
                f"({current}/{cap})"
            )
    return warning, block
