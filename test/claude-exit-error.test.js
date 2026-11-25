'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatClaudeExitError } = require('../electron/claude-runner');

const DIAG = '[claude-code:unrecognized_model] {"model":"claude-opus-5-5","query_source":"compact"}';

test('result error text wins over a diagnostic-only stderr', () => {
  const msg = formatClaudeExitError('exit', 1, `${DIAG}\n`,
    'Prompt is too long · the request is ~1234567 tokens (limit 1000000)');
  assert.equal(msg, 'exit 1: Prompt is too long · the request is ~1234567 tokens (limit 1000000)');
  assert.match(msg, /prompt is too long/i, 'context-overflow retry regex must see the real error');
});

test('diagnostic-only stderr with no result still reads as (no stderr)', () => {
  const msg = formatClaudeExitError('claude exited', 1, DIAG, '');
  assert.equal(msg, 'claude exited 1: (no stderr)');
  assert.match(msg, /exit(?:ed)?\s+\d+.*\(no stderr\)/i, 'channel retry regex must still fire');
});

test('real stderr is kept after the result text', () => {
  const msg = formatClaudeExitError('exit', 1, `${DIAG}\nAPI Error: 502 bad gateway`, '');
  assert.equal(msg, 'exit 1: API Error: 502 bad gateway');
});
