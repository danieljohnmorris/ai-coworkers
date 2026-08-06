# Coworker builder guide

This is the front door for people who want to **build a coworker** rather
than work on the harness itself. No engineering background assumed. If you
can edit a text file and paste a command into a terminal, you can get a
coworker running.

For the technical overview of the whole system, see [README.md](../README.md).
For the AI assistant or engineer working alongside you, the setup guide is
[AGENTS.md](../AGENTS.md).

---

## What is a coworker?

A coworker is a small autonomous helper that runs continuously in the
background — like an intern who never sleeps. It watches the world through
**read-only sensors** (your Linear tickets, your Slack mentions, a GitHub
repo, a Gmail inbox), thinks about what it saw, and occasionally takes an
action — **but only within the boundaries you set**. If it's unsure, it
asks you. If it hits a limit, it stops. It leaves a trail so you can
always see what it decided and why.

Every coworker lives in its own directory. That directory holds a few
markdown files describing who it is and what it may do, a JSON config for
behavioural settings, and a `state/` folder where it keeps its notes and
logs.

## Make one

Pick a starting template that resembles what you want:

```
cp -r examples/generic-triage coworkers/alex
```

The `examples/` folder has templates for ticket triage, PR review, project
management, incident tracing, changelog writing, and a couple more. Copy
the one closest to your intent and rename the copy.

If you'd rather answer a few questions and have the skeleton generated for
you, run:

```
bin/new-coworker.sh alex
```

or the interview version:

```
bin/new-coworker-interview.sh alex
```

Once the folder exists, configure the coworker's behaviour with the
wizard:

```
bin/configure.sh alex
```

The wizard walks you through each setting one at a time, shows you what it
means, and offers a sensible default. Press Enter to accept a default;
type a value to change it.

## Configure it

Two things you'll edit:

**Behaviour** — `coworkers/alex/config.json`. Managed by the wizard
above. Controls things like how the coworker wakes up, how many tools it
may call in one turn, whether it masks sensitive identifiers before
thinking about them. You never have to hand-edit this file; the wizard
does it for you.

**Personality and authority** — the markdown files under
`coworkers/alex/role/`. These describe who the coworker is, what it owns,
what it may decide alone versus escalate, what it must never touch, and
what recurring rituals it runs (a daily standup summary, a weekly cleanup,
etc.). Open them in any text editor and write in plain English. There is
**no compile step** — save the file and the coworker picks up the change
on its next tick.

The most important role file is `BOUNDARIES.md`. Read it. Adjust it. This
is where you tell the coworker what it must never do (delete tickets,
send emails on your behalf, touch a particular project) and where you
cap its resources (max LLM calls per day, max background jobs). The
coworker checks every action against this file before running it.

## Connect a service

Coworkers can talk to Linear, Slack, Gmail, GitHub, and anything with an
MCP server. Each service has its own setup script:

```
bin/setup-slack.sh alex
bin/setup-gmail.sh alex
```

Linear is set up by editing `coworkers/alex/.env` and adding an MCP
server line — the coworker's first tick prints a URL you open in a
browser to authorise. See AGENTS.md for the exact snippet.

Secrets (API keys, tokens) always go in the coworker's `.env` file, never
in `config.json`. The setup scripts handle this for you.

## Watch it work

Start the coworker in safe mode (nothing it does will actually happen —
you see what it *would* have done):

```
node --experimental-strip-types --no-warnings src/index.ts alex
```

While it's running, in another terminal:

```
bin/status.sh alex
tail -f coworkers/alex/state/highlights.log
```

`status.sh` gives you a one-shot summary — is it running, is it live or
dry-run, how many ticks today, what did it last do. `highlights.log`
scrolls its thoughts and actions in near-real-time.

Once you trust it, promote it to live by adding `--live` on the command
line. Watch it for a day in dry-run first. There's no rush.

## When it goes wrong

**The coworker asks you a question.** Answer with:

```
bin/answer.sh alex "yes, go ahead"
```

The next tick, it picks up your reply and continues.

**You want to know why it did something.** Check the highlights log for
the decision, then check the events database:

```
sqlite3 coworkers/alex/state/events.db \
  "SELECT ts, kind, substr(payload,1,200) FROM events ORDER BY id DESC LIMIT 20"
```

Every deliberation, every proposed action, every boundary check, every
sensor read is in there.

**A boundary blocked it.** You'll see a `boundary.block` line in the
highlights log with the reason. Either the coworker was about to do the
right thing and your boundary is too tight, or the coworker was about to
do the wrong thing and the boundary saved you. Read `BOUNDARIES.md` and
decide.

**Something crashed before the log started.** Check
`coworkers/alex/state/crash.log`.

## Get help from your AI

Any modern AI coding assistant — Claude Code, Cursor, GPT — can read this
repo cold and help you configure a coworker. Point it at:

- `src/runtime/config-schema.json` for the list of every behavioural knob,
  what it does, and what values it accepts. The assistant can write a
  valid `config.json` from this alone.
- `AGENTS.md` for the deeper technical view of how the harness works.
- The `role/*.md` files under `examples/` for reference personalities and
  boundary shapes worth copying.

You do not have to learn how the harness works. Describe what you want
the coworker to do; let your assistant translate that into the right
files.

## Where to go next

- Deeper technical overview: [README.md](../README.md).
- For your AI assistant or an engineer: [AGENTS.md](../AGENTS.md).
- Why config is split between `.env` and `config.json`:
  [ADR 0007](adr/0007-config-file-vs-env-vars.md).
