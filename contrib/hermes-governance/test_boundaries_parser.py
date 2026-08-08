"""Standalone pytest suite for boundaries_parser.

No Hermes runtime is required; import is direct so the test file works
whether or not the plugin has been installed into ``~/.hermes/plugins``.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the plugin dir importable regardless of pytest's cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import boundaries_parser as bp  # noqa: E402


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_empty_input_yields_empty_ruleset():
    rs = bp.parse_boundaries("")
    assert rs.is_empty()
    assert rs.rule_count() == 0


def test_missing_file_returns_empty(tmp_path):
    rs = bp.load_boundaries(tmp_path / "does-not-exist.md")
    assert rs.is_empty()


def test_case_insensitive_headings():
    text = """
# MUST NOT TOUCH
- prod-db

## Tool Field Allowlist
- write_file: path, content

### RESOURCE LIMITS
- Max LLM calls per day: 500
"""
    rs = bp.parse_boundaries(text)
    assert "prod-db" in rs.must_not_touch
    assert rs.field_allowlist["write_file"] == ["path", "content"]
    assert rs.resource_limits["max_llm_calls_per_day"] == 500


def test_ignores_code_fenced_bullets():
    text = """
## Must not touch
- realrule
```
- fake_in_code_fence
```
- anotherrule
"""
    rs = bp.parse_boundaries(text)
    assert "realrule" in rs.must_not_touch
    assert "anotherrule" in rs.must_not_touch
    assert "fake_in_code_fence" not in rs.must_not_touch


def test_ignores_html_comments():
    text = """
## Must not touch
<!-- - commented_out -->
- livepath
"""
    rs = bp.parse_boundaries(text)
    assert "livepath" in rs.must_not_touch
    assert "commented_out" not in " ".join(rs.must_not_touch)


def test_malformed_resource_lines_tolerated():
    text = """
## Resource limits
- Max LLM calls per day: not-a-number
- Max LLM calls per day: 500
- garbage without colon
"""
    rs = bp.parse_boundaries(text)
    assert rs.resource_limits.get("max_llm_calls_per_day") == 500


# ---------------------------------------------------------------------------
# must-not-touch evaluation
# ---------------------------------------------------------------------------


def _rs_with_denylist(*entries: str) -> bp.Ruleset:
    rs = bp.Ruleset()
    rs.must_not_touch = list(entries)
    return rs


def test_must_not_touch_matches_tool_name_substring():
    rs = _rs_with_denylist("delete")
    reason = bp.check_must_not_touch(rs, "shell.delete_file", {"path": "/x"})
    assert reason is not None and "delete" in reason


def test_must_not_touch_matches_arg_value():
    rs = _rs_with_denylist("production")
    reason = bp.check_must_not_touch(
        rs, "http_get", {"url": "https://production.example.com/health"}
    )
    assert reason is not None


def test_must_not_touch_no_match_passes():
    rs = _rs_with_denylist("production")
    assert (
        bp.check_must_not_touch(rs, "http_get", {"url": "https://staging.example.com"})
        is None
    )


def test_must_not_touch_word_boundary_avoids_false_positive():
    # "billing" must not match inside "billion"
    rs = _rs_with_denylist("billing")
    assert (
        bp.check_must_not_touch(rs, "http_get", {"note": "one billion users"}) is None
    )


# ---------------------------------------------------------------------------
# Field allowlist evaluation
# ---------------------------------------------------------------------------


def _rs_with_allow(tool: str, fields: list[str]) -> bp.Ruleset:
    rs = bp.Ruleset()
    rs.field_allowlist[tool] = fields
    return rs


def test_allowlist_permits_listed_keys():
    rs = _rs_with_allow("mcp.linear.update_issue", ["labelIds"])
    assert (
        bp.check_field_allowlist(rs, "mcp.linear.update_issue", {"labelIds": ["a"]})
        is None
    )


def test_allowlist_blocks_extra_key():
    rs = _rs_with_allow("mcp.linear.update_issue", ["labelIds"])
    reason = bp.check_field_allowlist(
        rs, "mcp.linear.update_issue", {"labelIds": ["a"], "title": "no"}
    )
    assert reason is not None and "title" in reason


def test_allowlist_untracked_tool_passes():
    rs = _rs_with_allow("mcp.linear.update_issue", ["labelIds"])
    assert bp.check_field_allowlist(rs, "some.other.tool", {"foo": 1}) is None


# ---------------------------------------------------------------------------
# Resource limits
# ---------------------------------------------------------------------------


def test_resource_limit_parses():
    text = """
## Resource limits
- Max LLM calls per day: 500
"""
    rs = bp.parse_boundaries(text)
    assert rs.resource_limits["max_llm_calls_per_day"] == 500


def test_resource_limit_missing_is_noop():
    rs = bp.Ruleset()
    counter = bp.ResourceCounter()
    warn, block = bp.check_resource_limits(rs, counter, "any_tool")
    assert warn is None and block is None


def test_resource_limit_blocks_on_exceed():
    rs = bp.Ruleset()
    rs.resource_limits["max_llm_calls_per_day"] = 2
    counter = bp.ResourceCounter()
    # Two observations OK, third exceeds.
    _, b1 = bp.check_resource_limits(rs, counter, "t")
    _, b2 = bp.check_resource_limits(rs, counter, "t")
    _, b3 = bp.check_resource_limits(rs, counter, "t")
    assert b1 is None and b2 is None
    assert b3 is not None and "exceeded" in b3
