# hermes-governance (moved)

The Hermes plugin that ports ai-coworkers' `BOUNDARIES.md` governance
layer into a runtime-enforced `pre_tool_call` gate lives at its own
repository now:

**https://github.com/danieljohnmorris/hermes-governance**

Install:

```
git clone https://github.com/danieljohnmorris/hermes-governance ~/.hermes/plugins/hermes-governance
```

Then place a `BOUNDARIES.md` in `$HERMES_HOME` (or `./BOUNDARIES.md`,
or `$HOME/.hermes/BOUNDARIES.md`). Restart Hermes; the plugin loads on
`on_session_start` and gates on `pre_tool_call`.

The TypeScript reference implementation of the same rule shapes lives
in this repo at `src/runtime/boundaries.ts`.
