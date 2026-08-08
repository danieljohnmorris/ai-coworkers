# hermes-governance

The BOUNDARIES.md governance layer from
[ai-coworkers](https://github.com/dan/ai-coworkers), packaged as a
[Hermes](https://github.com/NousResearch/hermes-agent) plugin.
Runtime-enforced tool-call gating from a plain-markdown policy file.

## What it does

Hermes trusts SOUL.md prose to guide behaviour. This plugin adds
runtime enforcement: on every `pre_tool_call`, the plugin evaluates
the proposed call against three rule types parsed from
`BOUNDARIES.md`. Any violation is blocked before the tool runs — the
model cannot accidentally step outside the policy, even under
adversarial prompting, because the block happens in the host, not in
the model.

Three rule types are supported (shapes match
[`src/runtime/boundaries.ts`](https://github.com/dan/ai-coworkers/blob/main/src/runtime/boundaries.ts)
in the ai-coworkers repo):

| Rule | Heading pattern | Bullet shape |
|---|---|---|
| Must not touch | `## Must not (touch\|do\|write\|call)` (also `Never`, `Forbidden`, `Do not`) | `- <substring>` |
| Tool field allowlist | `## Tool field allowlist` (also `Field allowlist`) | `- <tool.name>: field1, field2` |
| Resource limits | `## Resource limits` | `- Max LLM calls per day: N` |

Must-not-touch entries are checked with word-boundary matching against
the tool name and every string value in the args (so `billing` does
not spuriously match `billion`).

## Why not just prose in SOUL.md?

Prose is an aspiration; the plugin is a fence. Two layers cost little
and catch different failure modes:

- **Prose** teaches the model why the boundary exists — the model can
  reason about grey areas and escalate.
- **Runtime enforcement** guarantees the model cannot cross a hard
  line no matter how the prompt is worded, how tools chain, or how a
  prompt injection tries to reframe the task.

## Install

The plugin ships as a directory under `contrib/` in the ai-coworkers
repo and is NOT auto-installed anywhere. To use it in Hermes:

```
cp -r contrib/hermes-governance ~/.hermes/plugins/hermes-governance
```

Then enable it in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - hermes-governance
```

Drop a `BOUNDARIES.md` at any of the discovery paths:

1. `$HERMES_HOME/BOUNDARIES.md`
2. `./BOUNDARIES.md` (project cwd)
3. `$HOME/.hermes/BOUNDARIES.md`

Missing file = plugin is a no-op with a warning; Hermes will not
crash.

## Example BOUNDARIES.md

```markdown
## Must not touch

- production
- billing-service
- /etc/shadow

## Tool field allowlist

- mcp.linear.update_issue: labelIds, comment
- write_file: path, content

## Resource limits

- Max LLM calls per day: 500
- Max LLM calls per 5h window: 200
```

See [`example/BOUNDARIES.md`](example/BOUNDARIES.md) for the full
sample.

## Behaviour

On session start the plugin logs:

```
[hermes-governance] loaded N rules from <path>
```

On every `pre_tool_call` the plugin evaluates the rules in order
(must-not-touch, field allowlist, resource limits). The first
violation returns a Hermes block verdict:

```python
{"action": "block", "message": "hermes-governance blocked this call: <reason>"}
```

Every block is appended as a JSON line to
`$HERMES_HOME/hermes-governance/blocks.log` with a UTC timestamp, the
tool name, a redacted copy of the args (keys matching
`token|secret|password|api_key|bearer|authorization` are masked), and
the block reason.

## Tests

```
pytest contrib/hermes-governance/test_boundaries_parser.py
```

Tests are standalone — they import `boundaries_parser` directly and
do not require a Hermes runtime.

## Compatibility

- Matches the Hermes plugin API as of the version bundled in
  `~/.hermes/hermes-agent/` at the time this plugin was written.
  The `_on_pre_tool_call` signature (`tool_name`, `args`, `**_`) and
  block verdict shape (`{"action": "block", "message": "..."}`) mirror
  `plugins/security-guidance/__init__.py` verbatim.
- If Hermes changes the hook shape (rename, argument reordering, new
  required kwargs, different block verdict schema), this plugin will
  need updating. Every hook callback uses `**_: Any` to tolerate
  additional kwargs Hermes may pass in future versions.

## Direct-import note

The plugin directory is named `hermes-governance` (with a dash) to
match Hermes conventions. That means `python -c "import
contrib.hermes_governance"` will not work — Python identifiers cannot
contain dashes. Hermes loads plugins by directory (via
`importlib.util.spec_from_file_location`), so this is fine at runtime.
Tests import `boundaries_parser` from the same directory via
`sys.path` manipulation to avoid the issue.

## Cross-reference

- Reference implementation:
  [`src/runtime/boundaries.ts`](../../src/runtime/boundaries.ts)
- ai-coworkers repo: https://github.com/dan/ai-coworkers
- Hermes plugin API docstring:
  `~/.hermes/hermes-agent/hermes_cli/plugins.py`
- Sibling reference plugins in
  `~/.hermes/hermes-agent/plugins/security-guidance/` and
  `~/.hermes/hermes-agent/plugins/disk-cleanup/`

## Known gaps

- **Resource limits are session-local.** The `Max LLM calls per day`
  counter resets when the Hermes session restarts. True per-day
  accounting would require wiring into the host's session store — out
  of scope for this proof of concept.
- **All tool calls count equally against LLM caps.** The `Max LLM
  calls per day` rule is observed on every `pre_tool_call`, not on
  `post_llm_call`. A more precise implementation would hook
  `post_llm_call` for LLM-specific caps.
