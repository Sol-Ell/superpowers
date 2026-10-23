# Superpowers on DeepSeek Harness (`dsh`)

This repository is also a **DeepSeek Harness bundle**: install it like any other
dsh plugin, remove it the same way, and nothing outside the profile changes.

```bash
git clone https://github.com/Sol-Ell/superpowers ~/.local/share/superpowers
dsh plugin --profile web add ~/.local/share/superpowers   # install
dsh plugin --profile web remove superpowers               # remove
```

Install from a stable path outside your project directories: the profile keeps a
`link:` to this checkout, so moving it afterwards leaves the bundle pointing at
nothing (re-run the two commands from the new path). Restart `dsh` after either
command; a `git pull` in the checkout is the update path.

`dsh plugin remove` drops the dependency and the bundle layer, so the skills and
the bootstrap disappear with it. pnpm may leave the profile's
`node_modules/superpowers` symlink behind; delete it by hand if you want a
pristine tree.

## What gets installed

| Piece | Effect |
| --- | --- |
| `dsh/plugin.js` | One Cordis plugin, **zero runtime dependencies** (Node built-ins only) |
| `dsh/cordis.patch.yml` | The bundle layer: one row mounting `./plugin.js` beside the patch |
| `package.json` → `dsh.bundle.patch` | What makes dsh treat this package as a profile layer |

The plugin does two things:

1. **Registers the skills.** Every `skills/<name>/SKILL.md` becomes a candidate in
   the harness skill registry, at bundled rank, with its directory as the resource
   base so `references/` resolve. They appear in the session catalog and load
   through the `skill` tool under their **bare names** (`brainstorming`, not
   `superpowers:brainstorming`). `/brainstorming` also works.
2. **Injects the bootstrap.** On `agent/created` it hands the agent one
   user-role message containing `using-superpowers` wrapped in the upstream
   `<EXTREMELY_IMPORTANT>` frame, followed by the inlined DSH tool mapping from
   `skills/using-superpowers/references/dsh-tools.md`.

It injects once per session: a session whose surface already has history (a
resume, or a fork) is left alone on the assumption that the bootstrap is part of
that history — true for every session this bundle created, not for one persisted
before the install. A new session, including one created after a clear, injects
again. Subagent sessions never bootstrap (`origin: 'subagent'`). dsh 0.2
announces no compaction event, so after a compaction the bootstrap survives only
as far as the summarizer preserved it.

No `AGENTS.md` edit, no global skill directory, no hook bridge, no profile
`customSkillDirs`, no user configuration of any kind.

## Verify

```bash
bash tests/dsh/run-tests.sh        # offline: provider, parsing, injection rules
bash tests/dsh/verify-live.sh      # live: runs a real session and inspects its log
```

The offline suite cannot prove the runtime *emits* the event it binds; only the
live check can. It needs model credentials (`DEEPSEEK_API_KEY` or the harness
credential store) and asserts that a real session log contains the injected
message.

Then, in a **new** session:

- Ask **"What are your superpowers?"** — a working install answers from the
  bootstrap before loading anything.
- Acceptance test: **"Let's make a react todo list"** — `brainstorming` must ask a
  question before any code is written.

## How it works

- **Provider.** `ctx.skills.registerProvider` returns candidates built from each
  `SKILL.md`'s YAML frontmatter (`name`, `description`, optional `whenToUse`).
  Only the flat scalar subset the skill format uses is parsed (including `|`/`>`
  block scalars); a malformed entry is skipped with a warning rather than
  advertised with a corrupt description. Bodies are re-read on every load, so a
  body edit needs no restart — but the catalog is cached per process until the
  plugin reloads, so a *newly added* skill needs `dsh` restarted.
- **Injection.** On `agent/created` (the dsh 0.2 seam; `agent/session-start` no
  longer exists) the plugin calls `agent.inject()` with an identified user
  message. The registry announces the agent serially and the loop holds queued
  input until listeners finish, so the message lands before the first request.
  The message carries `source: { kind: 'superpowers', form: 'instructions' }`,
  the merge-extensible source convention `dsh-agent-instructions` also uses.
- **Precedence.** Bundled rank is 600, so a project (`.dsh/skills`,
  `.agents/skills`) or user (`~/.dsh/skills`) skill with the same name wins over
  the bundled copy.

## Limits

- **Sandbox.** DSH defaults to `workspace-write`: writes outside the session
  workspace are denied, including `git worktree add ../name`. Keep worktrees
  inside the workspace, or widen the policy deliberately.
- **Sessions already running before the install** keep the pipeline they booted
  with; the next session gets the bootstrap and the catalog from the mounted
  bundle. Restart `dsh` if the install happened before the process started, or to
  be sure of a clean mount.
- **Sessions persisted before the install are not retrofitted.** They have
  history, so the bundle leaves them alone — resuming one, or forking one, does
  not add the bootstrap. Start a new session.
- **Compaction.** There is no compaction announcement in dsh 0.2, so a very long
  session that compacts below the bootstrap loses it — the same caveat the Hermes
  integration documents. Start a new session if skills stop triggering.
- **Ordering with other skill bundles.** Same-name skills resolve by rank; this
  bundle never wins against project or user roots, which is deliberate.
- **Upstream.** Superpowers has no official DSH integration. This port touches no
  skill body: it adds `dsh/`, `tests/dsh/`, and one reference file
  (`skills/using-superpowers/references/dsh-tools.md`), which is the sanctioned
  place for harness-specific tool guidance.
