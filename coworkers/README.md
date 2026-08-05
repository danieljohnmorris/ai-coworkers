# coworkers/

**This directory is gitignored (except this file).**

Each subdirectory under `coworkers/` is one running instance — real role docs
and live state (sqlite dbs, memory files, logs, worktrees). It is per-machine
and often contains personal workspace facts, API-authored comments, and
learned memory. It must never be committed.

To create a new coworker instance:

```
bin/new-coworker.sh <name>
```

Or copy from a sanitised template:

```
cp -r examples/generic-triage coworkers/alex-triage
$EDITOR coworkers/alex-triage/role/*.md
```

Then run:

```
node --experimental-strip-types --no-warnings src/index.ts alex-triage
```

Sanitised reference templates live under `examples/`.
