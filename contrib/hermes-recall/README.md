# hermes-recall

A skill for [Hermes](https://github.com/NousResearch/hermes-agent) that
teaches an agent to recall from its own memory by **drill-down**: start at
the coarsest summary it has, descend level by level to the raw notes and
log rows underneath, and refuse to answer when nothing matches confidently.

It is a pure `SKILL.md` playbook — no scripts, no plugins, no hooks. It
works entirely over whatever memory Hermes already has (markdown notes plus
any SQLite database the agent keeps), so it needs no knowledge of Hermes
internals and nothing has to be installed beyond the skill folder itself.

## Install

Copy (or clone) the skill into your Hermes skills directory, under a
category folder if you use them:

```
mkdir -p ~/.hermes/skills/memory
cp -r contrib/hermes-recall ~/.hermes/skills/memory/hermes-recall
```

or, from a checkout of this repository:

```
git clone https://github.com/danieljohnmorris/ai-coworkers
cp -r ai-coworkers/contrib/hermes-recall ~/.hermes/skills/memory/hermes-recall
```

If your Hermes reads skills from a different directory, put it there
instead and make sure that directory is the one your configuration points
at for skills.

## Enable

Restart your Hermes session (or start a new one) so the skills directory is
rescanned. The skill is procedural memory: it loads as context, it does not
need to be invoked like a tool. If your configuration supports pinning or
activating specific skills, add `hermes-recall` to that list to make sure
it is always in context rather than discovered on demand.

## Verifying it works

In a Hermes session, ask the agent to run **step 1 of the playbook** —
"index your memory: list the notes and memory files you have, names only"
— and watch what comes back.

You should observe it enumerate its notes/memory index (file names, and
table names if it keeps a database) *before* opening any content. That
listing is the observable side effect that the skill loaded and is being
followed: without it, an agent asked about a memory topic tends to open
files immediately or answer from its weights. Then give it a real recall
question and check it reports the path it walked — entry point, references
followed, notes or rows it ended in — or an explicit refusal if nothing
matched.

## Uninstall

Delete the folder:
`rm -rf ~/.hermes/skills/memory/hermes-recall` and restart the session.

## Reference implementation

ai-coworkers ships the same pattern as a native, deterministic tool over
an explicit memory ladder (rollups with levels and source-event ranges):
`src/tools/mem_walk.ts`, design in
[docs/adr/0008-progressive-resolution-memory.md](../../docs/adr/0008-progressive-resolution-memory.md).
This skill is the tool-free, generic version of that idea.
