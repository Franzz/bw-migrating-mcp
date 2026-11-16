// Chat with Claude about the audit. Claude gets the audit summary in its system prompt,
// a local tool to query the audit snapshot, and the read-only bw-mcp tools for live
// look-ups in the BW system.
//
// Two routes, picked at start (CHAT_BACKEND=api|claude-code forces one):
//   api          Messages API with ANTHROPIC_API_KEY: a manual streaming tool loop here.
//   claude-code  headless Claude Code with the user's own Claude login (lib/claude-code.mjs).
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { callTool, listReadTools } from './mcp.mjs';
import { AUDIT_TOOL, runAuditQuery, systemPrompt } from './assistant.mjs';
import { findClaudeBinary, claudeCodeTurn, resetClaudeCodeSession } from './claude-code.mjs';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_TURNS = 25;

let anthropic = null;
const sessions = new Map(); // id -> { messages: MessageParam[], updatedAt }

const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let claudeBinary;

/** { backend: 'api' | 'claude-code' | null, detail } */
export function chatBackend() {
  const forced = process.env.CHAT_BACKEND;
  if (forced !== 'claude-code' && hasApiKey()) return { backend: 'api', detail: 'Claude API (API key)' };
  if (forced === 'api') return { backend: null, detail: 'CHAT_BACKEND=api but no ANTHROPIC_API_KEY is set' };
  claudeBinary ??= findClaudeBinary();
  if (claudeBinary) return { backend: 'claude-code', detail: `Claude Code with your Claude login (${claudeBinary})` };
  return { backend: null, detail: 'No API key and no Claude Code binary found' };
}

export function chatAvailable() {
  return Boolean(chatBackend().backend);
}

function truncate(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters. Narrow the request, e.g. a name pattern or a single object.]`;
}

let toolsCache = null;
async function tools() {
  toolsCache ??= listReadTools().then((t) => [AUDIT_TOOL, ...t]).catch((err) => { toolsCache = null; throw err; });
  return toolsCache;
}

export function resetSession(id) { sessions.delete(id); resetClaudeCodeSession(id); }

/**
 * Run one user turn. emit(event) receives:
 *   { type: 'session', id } | { type: 'text', delta } | { type: 'tool_start', id, name, input }
 *   { type: 'tool_end', id, name, ok, chars } | { type: 'done', stopReason, usage } | { type: 'error', message }
 */
export async function chatTurn({ sessionId, text, audit, emit, signal }) {
  const { backend, detail } = chatBackend();
  if (backend === 'claude-code') {
    return claudeCodeTurn({ sessionId, text, audit, emit, signal, binary: claudeBinary });
  }
  if (!backend) {
    emit({ type: 'error', message: `Chat unavailable: ${detail}. Set ANTHROPIC_API_KEY in audit-app/.env, or install Claude Code.` });
    return;
  }
  anthropic ??= new Anthropic();
  const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
  const session = sessions.get(id) || { messages: [] };
  sessions.set(id, session);
  emit({ type: 'session', id });

  const startLength = session.messages.length;
  session.messages.push({ role: 'user', content: text });
  const toolList = await tools();
  const system = systemPrompt(audit);
  const usage = { input: 0, output: 0, cacheRead: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system,
      tools: toolList,
      messages: session.messages,
    }, { signal });
    stream.on('text', (delta) => emit({ type: 'text', delta }));

    let message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // Roll the session back to before this user turn so the history stays valid.
      session.messages.length = startLength;
      if (signal?.aborted) return;
      throw err;
    }
    usage.input += message.usage?.input_tokens || 0;
    usage.output += message.usage?.output_tokens || 0;
    usage.cacheRead += message.usage?.cache_read_input_tokens || 0;
    session.messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'pause_turn') continue;
    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
      emit({ type: 'done', stopReason: message.stop_reason, usage });
      return;
    }

    const results = await Promise.all(toolUses.map(async (tu) => {
      emit({ type: 'tool_start', id: tu.id, name: tu.name, input: tu.input });
      try {
        const out = tu.name === AUDIT_TOOL.name
          ? runAuditQuery(audit, tu.input)
          : await callTool(tu.name, tu.input);
        const content = truncate(out || '(empty result)');
        emit({ type: 'tool_end', id: tu.id, name: tu.name, ok: true, chars: out.length });
        return { type: 'tool_result', tool_use_id: tu.id, content };
      } catch (err) {
        emit({ type: 'tool_end', id: tu.id, name: tu.name, ok: false, chars: 0 });
        return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: truncate(String(err.message || err)) };
      }
    }));
    session.messages.push({ role: 'user', content: results });
  }
  emit({ type: 'done', stopReason: 'max_turns', usage });
}
