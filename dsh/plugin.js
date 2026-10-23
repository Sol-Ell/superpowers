/**
 * Superpowers for DeepSeek Harness (`dsh`).
 *
 * One Cordis plugin, zero runtime dependencies:
 *
 *  - registers every `skills/<name>/SKILL.md` in this package with
 *    `ctx.skills`, so the skills appear in DSH's session catalog and load
 *    through the `skill` tool under their bare names;
 *  - injects the `using-superpowers` bootstrap (plus the DSH tool mapping)
 *    into each new top-level session before its first model request.
 *
 * Discovery and loading read from disk on demand, so `git pull` is the update
 * path and a skill body edit needs no restart. Installing or removing this
 * package is the whole lifecycle: no user config, no global skill directory.
 *
 * The injection seam is `agent/created`: since dsh 0.2 the agent registry
 * announces each agent there (the 0.1.x session-start event is gone),
 * listeners run serially, and the loop holds queued input until they finish —
 * so the message lands before the first request.
 *
 * @module superpowers/dsh
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILLS_DIR = join(ROOT, 'skills')
const BOOTSTRAP_FILE = join(SKILLS_DIR, 'using-superpowers', 'SKILL.md')
const MAPPING_FILE = join(SKILLS_DIR, 'using-superpowers', 'references', 'dsh-tools.md')

/** The runtime event a new session is announced on; see the module comment. */
export const EVENT = 'agent/created'
/** Provider name shown to the registry, and the grammar for a skill name. */
const PROVIDER = 'superpowers'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** `BUNDLED_SKILL_RANK` from @deepseek-ai/dsh-skill, inlined to stay dependency-free. */
const RANK = 600

/** Cordis plugin name. */
export const name = 'superpowers'
/** Mount only where a skill registry exists. */
export const inject = ['skills']

/**
 * Report a degraded-but-working condition. Cordis's logger is a callable
 * service, so `warn` is not always present; never swallow the message.
 * @param {object} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  const logger = ctx?.logger
  if (typeof logger?.warn === 'function') logger.warn(message)
  else if (typeof logger === 'function') logger(message)
  else console.warn(`[superpowers] ${message}`)
}

/**
 * Parse a `SKILL.md`'s YAML frontmatter into the fields DSH consumes
 * (`name`, `description`, optional `whenToUse`) plus the instruction body.
 *
 * Supports the subset the skill format uses: flat scalars, double- or
 * single-quoted strings, and `|` / `>` block scalars. An entry outside that
 * subset is skipped rather than advertised with a corrupt description.
 * @param {string} text file contents
 * @returns {{ name: string, description: string, whenToUse?: string, body: string } | undefined}
 */
export function parseSkill(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(source)
  if (block === null) return undefined

  const fields = parseFields(block[1])
  if (typeof fields.name !== 'string' || !SKILL_NAME.test(fields.name)) return undefined
  if (typeof fields.description !== 'string' || fields.description.length === 0) return undefined

  const skill = { name: fields.name, description: fields.description, body: source.slice(block[0].length) }
  if (typeof fields.whenToUse === 'string' && fields.whenToUse.length > 0) skill.whenToUse = fields.whenToUse
  return skill
}

/**
 * Read one `SKILL.md` and parse its frontmatter.
 * @param {string} file absolute path
 * @returns {ReturnType<typeof parseSkill>}
 */
function readSkill(file) {
  return parseSkill(readFileSync(file, 'utf8'))
}

/**
 * Turn a frontmatter block into a flat field map.
 * @param {string} body the text between the `---` fences
 * @returns {Record<string, string>}
 */
function parseFields(body) {
  const fields = {}
  const lines = body.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[index])
    if (entry === null) continue

    const [, key, raw] = entry
    const blockScalar = /^([|>])[+-]?[ \t]*$/.exec(raw.trim())
    if (blockScalar === null) {
      fields[key] = scalar(raw)
      continue
    }

    // Consume the indented continuation lines of a `|` (literal) or `>`
    // (folded) scalar.
    const collected = []
    while (index + 1 < lines.length && (/^[ \t]+\S/.test(lines[index + 1]) || lines[index + 1].trim() === '')) {
      collected.push(lines[index + 1])
      index++
    }
    const indents = collected.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)[0].length)
    const indent = indents.length === 0 ? 0 : Math.min(...indents)
    const stripped = collected.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
    fields[key] = blockScalar[1] === '|'
      ? stripped.join('\n').trim()
      : stripped.join('\n').replace(/[ \t]*\n[ \t]*/g, ' ').trim()
  }

  return fields
}

/**
 * Decode one flat YAML scalar: double-quoted (JSON-compatible escapes),
 * single-quoted, or plain.
 * @param {string} raw the text after the colon
 * @returns {string}
 */
function scalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // A plain scalar ends at a YAML comment; quoted scalars keep `#` verbatim.
  return value.replace(/[ \t]+#.*$/, '')
}

/**
 * Describe one parsed skill as a provider candidate.
 * @param {NonNullable<ReturnType<typeof parseSkill>>} skill
 * @param {string} dir the skill's directory, used as its resource base
 * @param {string} file the skill's `SKILL.md`
 */
function candidateOf(skill, dir, file) {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: dir },
    rank: RANK,
    locator: file,
    path: file,
  }
}

/**
 * Whether a directory entry resolves to a directory, following symlinks so a
 * skill linked into the checkout is discovered like a real one.
 * @param {import('node:fs').Dirent} entry
 * @param {string} dir absolute path of the entry
 * @returns {boolean}
 */
function isDirectory(entry, dir) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {object} ctx
 * @returns {object[]} every readable `skills/<name>/SKILL.md`, sorted by name
 */
function discover(ctx) {
  let entries
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  } catch (error) {
    warn(ctx, `could not read ${SKILLS_DIR}: ${String(error)}`)
    return []
  }

  const found = []
  for (const entry of entries) {
    const dir = join(SKILLS_DIR, entry.name)
    if (!isDirectory(entry, dir)) continue
    const file = join(dir, 'SKILL.md')
    try {
      const skill = readSkill(file)
      if (skill === undefined) {
        warn(ctx, `skipping ${file}: no usable name/description frontmatter`)
        continue
      }
      found.push(candidateOf(skill, dir, file))
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(ctx, `skipping ${file}: ${String(error)}`)
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Build the skill source for one plugin instance.
 * @param {object} ctx
 */
function createProvider(ctx) {
  return {
    name: PROVIDER,
    list: async () => discover(ctx),
    async get(candidate) {
      const file = typeof candidate.locator === 'string' ? candidate.locator : undefined
      if (file === undefined) return undefined
      let skill
      try {
        skill = readSkill(file)
      } catch {
        return undefined
      }
      if (skill === undefined) return undefined
      return { ...candidateOf(skill, join(file, '..'), file), content: skill.body }
    },
  }
}

/**
 * Compose the session-start context: the `using-superpowers` skill wrapped in
 * the upstream bootstrap frame, followed by the DSH tool mapping.
 *
 * The skill body is required; the mapping is not. A checkout without the
 * mapping still bootstraps, with a pointer telling the model to resolve tool
 * names from its live tool list.
 * @param {object} ctx
 * @returns {string}
 */
function bootstrapText(ctx) {
  const skill = readFileSync(BOOTSTRAP_FILE, 'utf8').trimEnd()

  let mapping
  try {
    mapping = readFileSync(MAPPING_FILE, 'utf8').trimEnd()
  } catch (error) {
    warn(ctx, `could not read ${MAPPING_FILE} (${String(error)}); injecting the bootstrap without the tool mapping`)
    mapping = 'The DSH tool mapping is missing from this checkout. Resolve tool names from your live tool list instead.'
  }

  return [
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. It is already loaded: do not call the 'skill' tool for it. For all other skills, call the 'skill' tool with the bare skill name (for example 'brainstorming', not 'superpowers:brainstorming'); the tool name is lowercase.**",
    '',
    skill,
    '',
    '**DeepSeek Harness tool mapping - already applied in this session; trust it over any other tool name a skill mentions:**',
    '',
    mapping,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n')
}

/**
 * @param {object} value
 * @returns {object} the same value, frozen recursively
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/**
 * Register the skill provider and the session-start bootstrap.
 * @param {object} ctx Cordis context with the `skills` service
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => createProvider(ctx))

  ctx.on(EVENT, ({ agent }) => {
    // A session restored with history (resume or fork) already carries the
    // bootstrap; a new session — including one created after a clear — is empty.
    const header = agent?.session?.header
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return
    const surface = agent?.session?.surface
    if (surface !== undefined && surface.nodes.length > 0) return

    let text
    try {
      text = bootstrapText(ctx)
    } catch (error) {
      warn(ctx, `could not read the bootstrap: ${String(error)}`)
      return
    }

    try {
      agent.inject(deepFreeze({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'superpowers', form: 'instructions' },
      }))
    } catch (error) {
      warn(ctx, `could not inject the bootstrap: ${String(error)}`)
    }
  })
}
