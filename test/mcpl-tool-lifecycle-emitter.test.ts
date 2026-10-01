/**
 * MCPL RFC-007 tool lifecycle — the emitter's pairing (started → exactly one
 * terminal, to exactly the connections the opening went to, unless their
 * grant no longer covers the call), host-unique call ids, and the grant
 * computation for the two toolLifecycle paths.
 *
 * Split from mcpl-tool-lifecycle.test.ts so each file stays small enough
 * that `node --test --test-force-exit` collects every suite in it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityGrant, computeGrant } from '../src/mcpl/capability-grant.js';
import {
  ToolLifecycleEmitter,
  parseToolObserveParams,
  type ToolLifecycleConfig,
  type ToolLifecycleParams,
  type ToolObserveRule,
} from '../src/mcpl/tool-lifecycle.js';
import type { ToolClass } from '../src/mcpl/tool-classes.js';
import type { McplCapabilities } from '../src/mcpl/types.js';

const OBSERVE = 'toolLifecycle.observe';
const INPUTS = 'toolLifecycle.inputs';

function observer(id: string, paths: string[], filter: ToolObserveRule[] | null = null) {
  const sent: ToolLifecycleParams[] = [];
  return {
    id,
    grant: new CapabilityGrant(new Set(paths), []),
    toolObserveFilter: filter,
    sendToolLifecycle: (p: ToolLifecycleParams) => { sent.push(p); },
    sent,
  };
}

function rules(raw: unknown): ToolObserveRule[] | null {
  const parsed = parseToolObserveParams({ rules: raw });
  assert.ok(parsed.ok, `rules should parse: ${JSON.stringify(raw)}`);
  return parsed.rules;
}

const DEFAULT_INPUTS: ToolLifecycleConfig = { observe: {}, inputs: { classes: 'default' } };

// ── Emitter: pairing, phases, revocation, ids ───────────────────────────────

function harness(opts: {
  observers: ReturnType<typeof observer>[];
  config?: Record<string, ToolLifecycleConfig>;
  classes?: Record<string, ToolClass[]>;
}) {
  let clock = 1000;
  const emitter = new ToolLifecycleEmitter({
    observers: () => opts.observers,
    configFor: (id) => opts.config?.[id],
    describe: (tool) => {
      const sep = tool.indexOf('--');
      const cls = opts.classes?.[tool] ?? ['shell'];
      return sep > 0
        ? { class: cls, serverId: tool.slice(0, sep), serverTool: tool.slice(sep + 2) }
        : { class: cls };
    },
  }, () => clock);
  return { emitter, tick: (ms: number) => { clock += ms; } };
}

const LONG_ID = (n: number) => `toolu_01${String(n).padStart(20, '0')}`;

describe('ToolLifecycleEmitter', () => {
  test('started on tool:started, completed on result — isError from the result, never its content', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter, tick } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(1), name: 'prov--run', input: { cmd: 'make' } });
    assert.equal(o.sent.length, 0, 'nothing before execution begins');
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(1) });
    tick(40);
    emitter.onResult('scout', LONG_ID(1), { success: true, isError: true, data: 'SECRET-OUTPUT' } as never);
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
    assert.equal(o.sent[1].isError, true);
    assert.equal(o.sent[1].durationMs, 40);
    assert.equal(o.sent[0].toolCallId, o.sent[1].toolCallId);
    assert.ok(!JSON.stringify(o.sent).includes('SECRET-OUTPUT'), 'vector 16: no outcome leakage');
    for (const p of o.sent) {
      for (const k of ['result', 'output', 'content']) assert.equal(k in p, false, `vector 17: no ${k}`);
    }
    assert.equal(emitter.openCount, 0);
  });

  test('dispatch failure after start → failed', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(2), name: 'prov--run', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(2) });
    emitter.onTrace({ type: 'tool:failed', callId: LONG_ID(2) });
    emitter.onResult('scout', LONG_ID(2), { success: false, isError: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'failed']);
    assert.equal('isError' in o.sent[1], false);
  });

  test('refused before execution → no events at all (§3)', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(3), name: 'prov--run', input: {} });
    emitter.onTrace({ type: 'tool:failed', callId: LONG_ID(3) });
    emitter.onResult('scout', LONG_ID(3), { success: false, isError: true });
    assert.equal(o.sent.length, 0);
    assert.equal(emitter.openCount, 0);
  });

  test('a path with no start trace still gets a paired opening', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(4), name: 'prose_help', input: {} });
    emitter.onResult('scout', LONG_ID(4), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('stream end aborts opened calls; unopened calls vanish; late results find nothing', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(5), name: 'prov--a', input: {} });
    emitter.register('scout', 'inf_1', { id: LONG_ID(6), name: 'prov--b', input: {} });
    emitter.register('other', 'inf_2', { id: LONG_ID(7), name: 'prov--c', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(5) });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(7) });
    emitter.abortOpen('scout');
    assert.deepEqual(o.sent.map((p) => `${p.tool}:${p.phase}`), ['prov--a:started', 'prov--c:started', 'prov--a:aborted']);
    emitter.onResult('scout', LONG_ID(5), { success: true });
    assert.equal(o.sent.length, 3, 'no second terminal (vector: no duplicate terminals)');
    assert.equal(emitter.openCount, 1, "the other agent's call stays open");
  });

  test('parallel calls pair by toolCallId', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(8), name: 'prov--a', input: {} });
    emitter.register('scout', 'inf_1', { id: LONG_ID(9), name: 'prov--b', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(8) });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(9) });
    emitter.onResult('scout', LONG_ID(9), { success: true });
    emitter.onResult('scout', LONG_ID(8), { success: true });
    const ids = o.sent.map((p) => `${p.toolCallId}:${p.phase}`);
    assert.deepEqual(ids, [`${LONG_ID(8)}:started`, `${LONG_ID(9)}:started`, `${LONG_ID(9)}:completed`, `${LONG_ID(8)}:completed`]);
  });

  test('observe revoked mid-call → no terminal; inputs revoked mid-call → terminal still sent (§4.5)', () => {
    const a = observer('a', [OBSERVE]);
    const b = observer('b', [OBSERVE, INPUTS]);
    const { emitter } = harness({ observers: [a, b] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(10), name: 'prov--a', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(10) });
    a.grant = a.grant.without(OBSERVE);
    b.grant = b.grant.without(INPUTS);
    emitter.onResult('scout', LONG_ID(10), { success: true });
    assert.deepEqual(a.sent.map((p) => p.phase), ['started']);
    assert.deepEqual(b.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('a filter change mid-call does not suppress the terminal (§6.5)', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(11), name: 'prov--a', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(11) });
    o.toolObserveFilter = [];
    emitter.onResult('scout', LONG_ID(11), { success: true });
    assert.deepEqual(o.sent.map((p) => p.phase), ['started', 'completed']);
  });

  test('terminals go only where the opening went', () => {
    const early = observer('early', [OBSERVE]);
    const late = observer('late', []);
    const { emitter } = harness({ observers: [early, late] });
    emitter.register('scout', 'inf_1', { id: LONG_ID(12), name: 'prov--a', input: {} });
    emitter.onTrace({ type: 'tool:started', callId: LONG_ID(12) });
    late.grant = new CapabilityGrant(new Set([OBSERVE]), []);
    emitter.onResult('scout', LONG_ID(12), { success: true });
    assert.deepEqual(early.sent.map((p) => p.phase), ['started', 'completed']);
    assert.equal(late.sent.length, 0, 'granted mid-call: no terminal without an opening');
  });

  test('toolCallId is host-unique: short ids and repeats are minted, provider-random ids kept (§3)', () => {
    const o = observer('obs', [OBSERVE]);
    const { emitter } = harness({ observers: [o] });
    const run = (agent: string, id: string) => {
      emitter.register(agent, 'inf', { id, name: 'prov--a', input: {} });
      emitter.onTrace({ type: 'tool:started', callId: id });
      emitter.onResult(agent, id, { success: true });
    };
    run('scout', 'call_0');
    run('scout', 'call_0');
    run('scout', LONG_ID(13));
    run('scout', LONG_ID(13));
    const opened = o.sent.filter((p) => p.phase === 'started').map((p) => p.toolCallId);
    assert.equal(new Set(opened).size, 4, `ids must be unique: ${opened.join(', ')}`);
    assert.ok(opened[0].startsWith('call_0~'));
    assert.equal(opened[2], LONG_ID(13), 'a provider-random id is used as is');
  });

  test('inert while nothing observes: register tracks nothing', () => {
    const o = observer('obs', []);
    const { emitter } = harness({ observers: [o] });
    emitter.register('scout', 'inf', { id: LONG_ID(14), name: 'prov--a', input: {} });
    assert.equal(emitter.openCount, 0);
  });

  test('the filter and the grant compose end to end', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([
      { match: { serverTool: 'click' }, input: ['x', 'y'] },
      { match: { class: 'comms' }, report: false },
      { match: {} },
    ]));
    const { emitter } = harness({
      observers: [o],
      config: { obs: DEFAULT_INPUTS },
      classes: { 'computer--click': ['computer'], 'chat--send': ['comms'], 'blender--execute': [] },
    });
    const go = (id: string, name: string, input: unknown) => {
      emitter.register('scout', 'inf', { id, name, input });
      emitter.onTrace({ type: 'tool:started', callId: id });
      emitter.onResult('scout', id, { success: true });
    };
    go(LONG_ID(20), 'computer--click', { x: 1, y: 2, button: 'left' });
    go(LONG_ID(21), 'chat--send', { text: 'private words' });
    go(LONG_ID(22), 'blender--execute', { code: 'import bpy' });
    const started = o.sent.filter((p) => p.phase === 'started');
    assert.deepEqual(started.map((p) => p.tool), ['computer--click', 'blender--execute']);
    assert.deepEqual(started[0].input, { x: 1, y: 2 });
    assert.equal(started[1].input, undefined);
    assert.ok(!JSON.stringify(o.sent).includes('private words'));
    assert.ok(!JSON.stringify(o.sent).includes('import bpy'));
  });
});

// ── Grant computation (deny by default; explicit via config or enabledCapabilities) ──

describe('toolLifecycle grant', () => {
  const caps = (o: Record<string, unknown>): McplCapabilities => ({ version: '0.5', ...o }) as unknown as McplCapabilities;
  const quiet = <T>(fn: () => T): T => {
    const orig = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = orig; }
  };

  test('advertised but not granted by default (RFC-007 §13.1 rows)', () => {
    const g = quiet(() => computeGrant(caps({ toolLifecycle: true }), {}));
    assert.equal(g.has(OBSERVE), false);
    assert.equal(g.has(INPUTS), false);
    assert.ok(g.deniedPaths.includes(OBSERVE) && g.deniedPaths.includes(INPUTS));
  });

  test('a toolLifecycle policy block is the explicit grant of the paths it states', () => {
    const g1 = quiet(() => computeGrant(caps({ toolLifecycle: true }), { toolLifecycle: { observe: {} } }));
    assert.equal(g1.has(OBSERVE), true);
    assert.equal(g1.has(INPUTS), false);
    const g2 = quiet(() => computeGrant(caps({ toolLifecycle: true }), { toolLifecycle: { observe: {}, inputs: { classes: 'default' } } }));
    assert.equal(g2.has(INPUTS), true);
  });

  test('enabledCapabilities grants explicitly too; never beyond the advertisement', () => {
    const g = quiet(() => computeGrant(caps({ toolLifecycle: { observe: true } }), { enabledCapabilities: ['toolLifecycle.*'] }));
    assert.equal(g.has(OBSERVE), true);
    assert.equal(g.has(INPUTS), false, 'inputs was not advertised');
  });
});
