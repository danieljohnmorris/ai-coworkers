# Tool cookbook — Hermes skills, MCP servers, or native code

Every coworker needs to *do things* — read Gmail, edit Google Docs,
query Postgres, whatever. You have three ways to give it that capability.
This page tells you which to pick per case.

## Decision tree

```
                     Do you need this tool at all?
                              |
                        no ---+--- yes
                                    |
                    Does a Hermes skill exist for it?
                              |
                        yes --+-- no
                         |         |
                 Reuse Hermes.     Does an MCP server exist?
                 Zero code.               |
                                    yes --+-- no
                                     |         |
                          Use MCP via .env.   Write native tool
                          Zero code.          under src/tools/.
```

Hermes wins when it exists because the community has already solved the
*setup UX* (guided OAuth walkthroughs baked into the SKILL.md itself),
not just the API surface. MCP wins when Hermes doesn't cover it because
the community has solved the *API surface* (well-defined tool schemas
+ auth). Native code is the last resort.

## Path A — reuse Hermes skills

Hermes is Nous Research's agent runtime. Its skills library (72+ at last
count, layered under `~/.hermes/skills/<category>/<skill>/SKILL.md`) is
loaded into an ai-coworker as procedural memory via
`src/adapters/hermes.ts`. Point `SKILLS_DIR` at the install:

```
SKILLS_DIR=~/.hermes/skills
ACTIVE_SKILLS=google-workspace,himalaya    # optional: inline full body
```

The coworker sees every skill's name + description; skills in
`ACTIVE_SKILLS` also get their full body inlined. When the coworker
needs to (say) send email, the `google-workspace` skill instructs it
through the OAuth setup interactively and then through the send.

**Available skills worth knowing** (partial list; run
`ls ~/.hermes/skills/*/` for the full inventory):

| Skill | Covers |
|---|---|
| `google-workspace` | Gmail, Calendar, Drive, Contacts, Sheets, Docs (guided OAuth setup, works headless) |
| `himalaya` | Gmail via App Password (2-min setup, email-only) |
| `airtable` | Airtable CRUD |
| `apple-notes` / `apple-reminders` / `imessage` / `findmy` | Apple ecosystem (macOS) |
| `github-code-review` / `github-auth` | GitHub PR workflow |
| `codebase-inspection` | LOC / language stats |
| `computer-use` | Desktop automation |
| `claude-code` / `codex` / `opencode` | Delegate coding to specific CLIs (we also do this natively via `code.delegate` + ACP — pick one) |

**Prereq:** Hermes agent installed (`pipx install hermes-agent` or the
Nous docs). Once installed the skills library is populated automatically.

**Trade-off:** many Hermes skills ship a Python execution layer alongside
SKILL.md; using them via ai-coworkers means Python is on the host. If
your coworker box is Node-only you're limited to skills whose SKILL.md
is fully self-executing prose (a subset).

**Verified working:** loaded 72 skills from a live Hermes install via
our adapter on 2026-08-06 (see `src/adapters/hermes.test.ts` recursion
test).

## Path B — MCP servers

The [Model Context Protocol](https://modelcontextprotocol.io) ecosystem
ships servers for most APIs. We spawn them as subprocesses via
`src/adapters/mcp.ts`; their tools land in the registry with the
declared prefix.

```
MCP_SERVERS='[
  {"name":"gdrive","command":"npx","args":["-y","@modelcontextprotocol/server-gdrive"]},
  {"name":"pg","command":"npx","args":["-y","@modelcontextprotocol/server-postgres","postgresql://..."]},
  {"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/scoped/path"]}
]'
```

**OAuth caveat.** MCP servers are subprocesses; they can't do a browser
OAuth flow while running headless. For Google APIs you have to do the
first-run OAuth manually **outside** the coworker:

1. Create OAuth 2.0 credentials in Google Cloud Console (Desktop App
   type), download `credentials.json`.
2. Run the MCP server once interactively:
   `npx @modelcontextprotocol/server-gdrive /path/to/credentials.json`
3. It prints a URL, visit in a browser, authorize, paste back the code;
   the server writes `token.json` (long-lived refresh token).
4. Only then wire it into `MCP_SERVERS` — it will pick up the cached token.

This is exactly the friction the Hermes google-workspace skill removes
(it guides the user through the same steps *from inside the chat*). If
your coworker interacts with a human who can do that setup in-chat,
prefer Hermes. If your coworker is genuinely unattended and you are the
one doing setup, MCP is fine.

## Path C — native code

Only when:
- No Hermes skill AND no MCP server exists.
- Boundary enforcement needs to inspect deep into arguments (MCP tool
  schemas are opaque enough that some checks are easier native).
- You want the tool to compose with our own state (event log, hygiene,
  entities) in ways an external subprocess cannot.

Add `src/tools/<name>.ts` exporting `ToolDef[]`; register in
`src/index.ts`. See `src/tools/linear.ts` for the canonical shape.

## Slack — the exception

Native `slack.ts` exists because we built it before MCP had a solid
Slack server. It is stable and shipped. If you want to consolidate to
Hermes or MCP, either works — no strong reason to migrate unless you
need features the native path does not cover.

## Credential handling

Under AIC-74, native tools declare `requiresCreds` and receive a filtered
env. MCP servers currently receive the whole coworker env — scope
sensitive tokens inside the MCP block's own `env`:

```
{"name":"gmail","command":"npx","args":[...], "env":{"GMAIL_OAUTH_TOKEN":"..."}}
```

Hermes skills that run scripts inherit `HERMES_HOME` and any env the
operator has set — same rule: don't put secrets in the coworker's own
env if the skill can pick them up from its own config.
