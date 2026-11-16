// Chat route through headless Claude Code (`claude -p`), signed in with the user's own
// Claude login: no API key. Each turn runs one Claude Code process with:
//   - no built-in tools (--tools ""), so no shell, file or web access;
//   - only bw-mcp (read scope) and the local audit_query server (--strict-mcp-config);
//   - only the read tools pre-approved; anything else is refused (--permission-mode dontAsk);
//   - --resume, so the turns of one conversation share their history.
// Personal use only: a personal Claude login must not serve other people's requests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listReadTools } from './mcp.mjs';
import { systemPrompt } from './assistant.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const launcher = process.env.BW_LAUNCHER || path.join(repoRoot, 'start-bw-mcp.mjs');
// Neutral working directory: no CLAUDE.md, .mcp.json or project settings of the repo apply.
const workDir = path.resolve(here, '..', 'data', 'claude-code');

const sessions = new Map(); // our session id -> Claude Code session id

function versionKey(dir) {
  return (dir.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
}

/** CLAUDE_CODE_BIN, then `claude` on PATH, then the newest binary bundled with the VS Code extension. */
export function findClaudeBinary() {
  if (process.env.CLAUDE_CODE_BIN) return fs.existsSync(process.env.CLAUDE_CODE_BIN) ? process.env.CLAUDE_CODE_BIN : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  const candidates = [];
  for (const base of ['.vscode-server/extensions', '.vscode/extensions', '.cursor/extensions']) {
    const root = path.join(os.homedir(), base);
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries.filter((x) => x.startsWith('anthropic.claude-code-'))) {
      const p = path.join(root, e, 'resources', 'native-binary', 'claude');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  candidates.sort((a, b) => {
    const [x, y] = [versionKey(a), versionKey(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return candidates[0] || null;
}

const SERVER_PREFIX = { 'mcp__bw-mcp__': '', mcp__audit__: '' };
const shortName = (name) => {
  for (const p of Object.keys(SERVER_PREFIX)) if (name.startsWith(p)) return name.slice(p.length);
  return name;
};

export function resetClaudeCodeSession(id) { sessions.delete(id); }

export async function claudeCodeTurn({ sessionId, text, audit, emit, signal, binary }) {
  fs.mkdirSync(workDir, { recursive: true });
  const id = sessionId && sessions.has(sessionId) ? sessionId : crypto.randomUUID();
  emit({ type: 'session', id });

  const readTools = (await listReadTools()).map((t) => `mcp__bw-mcp__${t.name}`);
  const mcpConfig = {
    mcpServers: {
      'bw-mcp': {
        type: 'stdio',
        command: process.execPath,
        args: [launcher],
        env: { BW_STDIO_SCOPES: 'read' },
      },
      audit: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(here, 'audit-mcp.mjs')],
        env: { AUDIT_TARGET: audit?.target?.key || 'generic' },
      },
    },
  };
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
    '--append-system-prompt', systemPrompt(audit),
  ];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  const resume = sessions.get(id);
  if (resume) args.push('--resume', resume);
  args.push('--allowedTools', [...readTools, 'mcp__audit__audit_query'].join(','));

  // This route is the subscription login: drop API credentials so Claude Code never uses them.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(binary, args, {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const onAbort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdin.end(text);

  let stderr = '';
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  const pendingTools = new Map();
  let gotResult = false;

  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
      sessions.set(id, e.session_id);
      const bw = (e.mcp_servers || []).find((s) => s.name === 'bw-mcp');
      if (bw && bw.status !== 'connected') emit({ type: 'error', message: `bw-mcp did not start in Claude Code (status: ${bw.status}).` });
    } else if (e.type === 'stream_event') {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit({ type: 'text', delta: ev.delta.text });
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) {
        if (b.type === 'tool_use' && !pendingTools.has(b.id)) {
          pendingTools.set(b.id, b.name);
          emit({ type: 'tool_start', id: b.id, name: shortName(b.name), input: b.input || {} });
        }
      }
    } else if (e.type === 'user') {
      const content = Array.isArray(e.message?.content) ? e.message.content : [];
      for (const b of content) {
        if (b.type === 'tool_result' && pendingTools.has(b.tool_use_id)) {
          const name = pendingTools.get(b.tool_use_id);
          pendingTools.delete(b.tool_use_id);
          const len = typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content || '').length;
          emit({ type: 'tool_end', id: b.tool_use_id, name: shortName(name), ok: !b.is_error, chars: len });
        }
      }
    } else if (e.type === 'result') {
      gotResult = true;
      if (e.session_id) sessions.set(id, e.session_id);
      if (e.is_error) {
        emit({ type: 'error', message: `Claude Code: ${e.result || e.subtype}` });
        // A failed resume would fail again on the next turn; start fresh then.
        if (/session|resume/i.test(String(e.result))) sessions.delete(id);
      }
      emit({
        type: 'done',
        stopReason: e.subtype === 'success' ? 'end_turn' : e.subtype,
        usage: { input: e.usage?.input_tokens, output: e.usage?.output_tokens, cacheRead: e.usage?.cache_read_input_tokens },
      });
    }
  }

  const code = await new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on('close', resolve)));
  signal?.removeEventListener('abort', onAbort);
  if (signal?.aborted) return;
  if (!gotResult) {
    throw new Error(`Claude Code exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
  }
}
