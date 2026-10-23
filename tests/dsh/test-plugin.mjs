/**
 * Offline tests for the DeepSeek Harness bundle (dsh/plugin.js).
 *
 * These exercise the plugin against a fake Cordis context: no dsh process, no
 * model, and no filesystem outside this repository. They cannot prove the
 * runtime emits the event — `tests/dsh/verify-live.sh` does that against a real
 * session log. Run with tests/dsh/run-tests.sh.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { EVENT, apply, inject as injectList, name, parseSkill } from '../../dsh/plugin.js'

const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url))
const PLUGIN_SOURCE = readFileSync(new URL('../../dsh/plugin.js', import.meta.url), 'utf8')

/** Skills on disk, counted independently of the plugin's discovery. */
const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)

/** Mount the plugin on a fake context and capture what it registered. */
function mount() {
  let provider
  const events = []
  const warnings = []
  const ctx = {
    skills: {
      registerProvider(create) {
        provider = create({ signal: new AbortController().signal, invalidate() {} })
      },
    },
    on(event, handler) {
      events.push({ event, handler })
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  apply(ctx)
  return { provider, events, warnings }
}

/** The single session-start listener the plugin registered. */
function sessionStart(events) {
  const found = events.filter((entry) => entry.event === EVENT)
  assert.equal(found.length, 1, `exactly one ${EVENT} listener`)
  return found[0].handler
}

/** A fake agent whose inject() records messages. */
function agent(header = {}, nodes = []) {
  const injected = []
  return { injected, agent: { session: { header, surface: { nodes } }, inject: (message) => injected.push(message) } }
}

test('declares a plugin that requires the skill registry', () => {
  assert.equal(name, 'superpowers')
  assert.deepEqual(injectList, ['skills'])
})

test('binds the injection to an event the runtime actually emits', () => {
  assert.equal(EVENT, 'agent/created')
  assert.ok(
    !PLUGIN_SOURCE.includes('agent/session-start'),
    'the removed 0.1.x event must not creep back in',
  )
})

test('registers every skills/<name>/SKILL.md as a candidate', async () => {
  const { provider } = mount()
  const candidates = await provider.list({})

  assert.equal(candidates.length, onDisk.length, 'every skill on disk is advertised')
  assert.ok(candidates.length >= 14, 'the shipped catalog is complete')
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    candidates.map((candidate) => candidate.name).toSorted(),
    'catalog is sorted by name',
  )
  assert.deepEqual(candidates.map((candidate) => candidate.name), onDisk.toSorted(), 'names match disk')
  assert.equal(new Set(candidates.map((candidate) => candidate.name)).size, candidates.length, 'names are unique')

  for (const candidate of candidates) {
    assert.match(candidate.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.ok(candidate.description.length > 0, `${candidate.name} has a description`)
    assert.equal(candidate.rank, 600)
    assert.equal(candidate.provider, 'superpowers')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
    assert.equal(candidate.resourceBase.kind, 'directory')
    assert.ok(existsSync(candidate.resourceBase.path), `${candidate.name} resource base exists`)
    assert.ok(candidate.resourceBase.path.endsWith(candidate.name))
    assert.equal(candidate.path, candidate.locator, 'the instruction file is exposed as the skill path')
  }

  for (const required of ['brainstorming', 'writing-plans', 'test-driven-development', 'using-superpowers']) {
    assert.ok(candidates.some((candidate) => candidate.name === required), `catalog contains ${required}`)
  }
})

test('loads a definition with frontmatter removed', async () => {
  const { provider } = mount()
  const [candidate] = (await provider.list({})).filter((entry) => entry.name === 'writing-plans')
  const definition = await provider.get(candidate, {})

  assert.ok(definition)
  assert.equal(definition.name, 'writing-plans')
  assert.ok(definition.content.length > 500)
  assert.ok(!definition.content.startsWith('---'), 'frontmatter is stripped from the body')
  assert.ok(!/^name: writing-plans$/m.test(definition.content), 'name field is not left in the body')
})

test('returns undefined for a locator that no longer exists', async () => {
  const { provider } = mount()
  const [candidate] = await provider.list({})
  const gone = { ...candidate, locator: '/nonexistent/superpowers/skills/gone/SKILL.md' }

  assert.equal(await provider.get(gone, {}), undefined)
})

test('parses the frontmatter shapes the skill format allows', () => {
  const plain = parseSkill('---\nname: demo\ndescription: Use when: a "quoted" case — with colon: yes\n---\nbody\n')
  assert.equal(plain.description, 'Use when: a "quoted" case — with colon: yes')
  assert.equal(plain.body.trim(), 'body')

  const quoted = parseSkill('---\nname: demo\ndescription: "escaped \\"quote\\" here"\n---\nbody\n')
  assert.equal(quoted.description, 'escaped "quote" here')

  const folded = parseSkill('---\nname: demo\ndescription: >\n  first line\n  second line\n---\nbody\n')
  assert.equal(folded.description, 'first line second line', 'folded scalar joins lines')

  const literal = parseSkill('---\nname: demo\ndescription: |\n  first line\n  second line\n---\nbody\n')
  assert.equal(literal.description, 'first line\nsecond line', 'literal scalar keeps newlines')

  assert.equal(parseSkill('no frontmatter here'), undefined)
  assert.equal(parseSkill('---\nname: Bad_Name\ndescription: x\n---\nbody\n'), undefined)
  assert.equal(parseSkill('---\nname: demo\ndescription: ""\n---\nbody\n'), undefined)
  assert.equal(parseSkill('---\nname: demo\n---\nbody\n'), undefined)

  const bom = parseSkill('\ufeff---\nname: demo\ndescription: after a BOM\n---\nbody\n')
  assert.equal(bom.description, 'after a BOM', 'a UTF-8 BOM does not drop the skill')

  const commented = parseSkill('---\nname: demo\ndescription: Use when testing # trailing note\n---\nbody\n')
  assert.equal(commented.description, 'Use when testing', 'plain scalars end at a YAML comment')
})

test('injects the bootstrap when a session is created', () => {
  const { events } = mount()
  const handler = sessionStart(events)
  const { agent: fake, injected } = agent()

  handler({ agent: fake, source: 'startup' })

  assert.equal(injected.length, 1)
  const message = injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'superpowers')
  assert.equal(message.source.form, 'instructions')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.ok(Object.isFrozen(message), 'message is frozen')

  const text = message.content[0].text
  assert.match(text, /^<EXTREMELY_IMPORTANT>/)
  assert.match(text, /You have superpowers/)
  assert.match(text, /## The Rule/, 'inlines the using-superpowers skill')
  assert.match(text, /DeepSeek Harness tool mapping/)
  assert.match(text, /`todo_write`/, 'inlines the harness tool mapping')
  assert.match(text, /<\/EXTREMELY_IMPORTANT>$/)
})

test('injects whenever the surface is empty, whatever the announced source', () => {
  const { events } = mount()
  const handler = sessionStart(events)

  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const { agent: fake, injected } = agent()
    handler({ agent: fake, source })
    assert.equal(injected.length, 1, `${source} injects into an empty session`)
  }
})

test('leaves a session that already has history alone', () => {
  const { events } = mount()
  const handler = sessionStart(events)
  const { agent: resumed, injected } = agent({}, [1, 2, 3])

  handler({ agent: resumed, source: 'resume' })
  assert.equal(injected.length, 0, 'restored history already carries the bootstrap')
})

test('does not inject into subagents', () => {
  const { events } = mount()
  const handler = sessionStart(events)

  for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }, { origin: 'subagent', delegationDepth: 2 }]) {
    const { agent: fake, injected } = agent(header)
    handler({ agent: fake, source: 'startup' })
    assert.equal(injected.length, 0, `skipped for ${JSON.stringify(header)}`)
  }
})

test('a fork with inherited history is left alone', () => {
  const { events } = mount()
  const handler = sessionStart(events)
  const { agent: forked, injected } = agent({ parentSession: 'session-parent' }, [1, 2])

  handler({ agent: forked, source: 'startup' })
  assert.equal(injected.length, 0)
})

test('a fork with an empty surface still bootstraps', () => {
  const { events } = mount()
  const handler = sessionStart(events)
  const { agent: forked, injected } = agent({ parentSession: 'session-parent' })

  handler({ agent: forked, source: 'startup' })
  assert.equal(injected.length, 1)
})
