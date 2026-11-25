'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withClaudeModelArg } = require('../electron/claude-runner');

test('EasyDeal model is promoted to an explicit Claude CLI argument', () => {
  const original = ['--print', '--verbose', 'hello'];
  const args = withClaudeModelArg(original, { ANTHROPIC_MODEL: '  gpt-6-astra  ' });

  assert.deepEqual(args, ['--model', 'gpt-6-astra', '--print', '--verbose', 'hello']);
  assert.deepEqual(original, ['--print', '--verbose', 'hello'], 'caller args must not be mutated');
});

test('blank model follows CC Switch and an existing CLI model is never duplicated', () => {
  assert.deepEqual(
    withClaudeModelArg(['--print', 'hello'], { ANTHROPIC_MODEL: '   ' }),
    ['--print', 'hello'],
  );
  assert.deepEqual(
    withClaudeModelArg(['--model', 'already-selected', '--print', 'hello'], { ANTHROPIC_MODEL: 'gpt-6-astra' }),
    ['--model', 'already-selected', '--print', 'hello'],
  );
  assert.deepEqual(
    withClaudeModelArg(['--model=already-selected', '--print', 'hello'], { ANTHROPIC_MODEL: 'gpt-6-astra' }),
    ['--model=already-selected', '--print', 'hello'],
  );
});

test('EasyDeal token model wins over a caller fallback model', () => {
  assert.deepEqual(
    withClaudeModelArg(
      ['--print', 'hello'],
      { ANTHROPIC_MODEL: 'gpt-6-astra' },
      { ANTHROPIC_MODEL: 'gpt-5.6-luna' },
    ),
    ['--model', 'gpt-6-astra', '--print', 'hello'],
  );
  assert.deepEqual(
    withClaudeModelArg(['--print', 'hello'], {}, { ANTHROPIC_MODEL: 'gpt-5.6-luna' }),
    ['--model', 'gpt-5.6-luna', '--print', 'hello'],
  );
});

test('main chat, warmup, headless and session runners all apply the same precedence rule', () => {
  const chat = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'chat-session.js'), 'utf8');
  const runner = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'claude-runner.js'), 'utf8');

  assert.equal(
    (chat.match(/withClaudeModelArg\(args, tokenOverride\.env\)/g) || []).length,
    2,
    'chat and warmup spawns must both pin the selected model',
  );
  assert.equal(
    (runner.match(/withClaudeModelArg\(args, tokenEnv, env\)/g) || []).length,
    2,
    'headless and session-based spawns must both pin the selected model',
  );
});

test('Token UI explains EasyDeal priority and the follow-CC-Switch option', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'token-view.js'), 'utf8');

  assert.match(view, /系统默认（跟随 CC Switch \/ Claude CLI）/);
  assert.match(view, /EasyDeal 指定（优先）/);
  assert.match(view, /若系统端点使用 CC Switch，转发时仍可能改写模型/);
  assert.match(view, /下一次请求<\/b>生效，无需新建会话/);
});
