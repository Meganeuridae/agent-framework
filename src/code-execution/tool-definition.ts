/** Compact agent-facing surface for Python orchestration and its execution lifecycle. */
import type { ToolDefinition } from '../types/index.js';
import { formatLimit, MAX_TIMER_MS } from './py-runner.js';

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

export function buildCodeExecutionToolDefinition(opts?: {
  idleReclaimMs?: number;
  toolCallTimeoutMs?: number;
  foregroundWaitMs?: number;
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  backgroundMaxLifetimeMs?: number;
}): ToolDefinition {
  const limits = scriptTimeLimits(opts);
  const idleMs = opts?.idleReclaimMs ?? 300_000;
  const reuse = idleMs === 0 ? 'until cancelled or the host stops' : `until ${idleMs}ms idle`;
  return {
    name: CODE_EXECUTION_TOOL_NAME,
    description:
      'Run Python with top-level await. Tools are async Python functions taking one dict and returning text; ' +
      "use tools['exact-tool-name']({...}) or the sanitized name ('--' becomes '__', other punctuation becomes '_'). " +
      'Use asyncio.gather for parallel calls. Tool errors return Error: text; image results become placeholders. ' +
      'Only printed stdout, stderr and return_code reach you; intermediate results stay in Python. ' +
      'Choose direct calls or code as useful, including for a single call. ' +
      `The tool waits at most ${opts?.foregroundWaitMs ?? 10_000}ms by default (override with wait_ms), then returns a running script_id. ` +
      'The script continues and completion notifies you. Use action=wait with script_id to inspect or wait again; ' +
      'wait_ms=0 inspects immediately. on_timeout=end_turn ends your turn if still running, with completion waking you. ' +
      'A wait timeout does not cancel execution. ' +
      `A foreground script is stopped after ${formatLimit(limits.defaultMs)}; pass time_limit_ms to set this call's limit ` +
      `(at most ${formatLimit(limits.maxMs)}; a background script runs up to ${formatLimit(limits.backgroundMaxMs)}). ` +
      `Ordinary calls share one Python interpreter; variables/imports persist ${reuse}. ` +
      'While a script is running that context is busy. background=true starts an independent interpreter, returns immediately, ' +
      'and makes await wake_agent(payload) available for explicit notifications. Clean background exits are silent unless ' +
      'you wait and yield; crashes notify you. Output is journaled to the reported workspace log when available. ' +
      'Background scripts are primary-agent-only; wakes are rate limited. action=list lists your scripts; action=cancel stops one. ' +
      `Inner tool calls time out after ${opts?.toolCallTimeoutMs ?? 270_000}ms. ` +
      'Cancellation stops Python, but already dispatched tools may still finish. ' +
      'Scripts and retained results do not survive host restart; the five most recently settled results are retained per agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Python code; top-level await is supported.' },
        action: { type: 'string', enum: ['run', 'wait', 'list', 'cancel'], description: 'run (default), wait/inspect a script, list scripts, or cancel one.' },
        script_id: { type: 'string', description: 'Execution id for wait or cancel.' },
        wait_ms: { type: 'integer', description: 'Observation budget, 0–60000 milliseconds; 0 returns immediately. Does not limit script lifetime.' },
        time_limit_ms: {
          type: 'integer',
          description: `Execution limit set when starting a script; stops Python when reached. Default ${limits.defaultMs}, at most ${limits.maxMs}; background scripts default to and are capped at ${limits.backgroundMaxMs}. Does not change when waiting again.`,
        },
        on_timeout: { type: 'string', enum: ['continue', 'end_turn'], description: 'After the observation budget expires, continue thinking (default) or end this turn. Completion will notify/wake you.' },
        background: { type: 'boolean', description: 'Independent interpreter with wake_agent and output journal. Returns immediately unless wait_ms or on_timeout is supplied.' },
      },
      required: [],
    },
  };
}

/**
 * A script's time limits: the default, the most an agent may ask for with
 * `time_limit_ms`, and the background lifetime (default and ceiling at once).
 */
export function scriptTimeLimits(opts?: {
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  backgroundMaxLifetimeMs?: number;
}): { defaultMs: number; maxMs: number; backgroundMaxMs: number } {
  // Every limit fits Node's timer range (MAX_TIMER_MS, ~24.8 days).
  const defaultMs = Math.min(MAX_TIMER_MS, opts?.scriptTimeoutMs ?? 600_000);
  return {
    defaultMs,
    // A ceiling below the default is refused when the framework is created
    // (validateCodeExecutionConfig); never below the default here either.
    maxMs: Math.min(MAX_TIMER_MS, Math.max(defaultMs, opts?.maxScriptTimeoutMs ?? defaultMs)),
    backgroundMaxMs: Math.min(MAX_TIMER_MS, opts?.backgroundMaxLifetimeMs ?? 86_400_000),
  };
}

/** Refuse a configuration whose time limits contradict each other. */
export function validateCodeExecutionConfig(cfg: { scriptTimeoutMs?: number; maxScriptTimeoutMs?: number }): void {
  const defaultMs = cfg.scriptTimeoutMs ?? 600_000;
  if (cfg.maxScriptTimeoutMs !== undefined && !(cfg.maxScriptTimeoutMs >= defaultMs)) {
    throw new Error(
      `codeExecution.maxScriptTimeoutMs (${cfg.maxScriptTimeoutMs}) must be at least scriptTimeoutMs (${defaultMs}): ` +
        'it is the most an agent may ask for, and the default is always allowed',
    );
  }
}
