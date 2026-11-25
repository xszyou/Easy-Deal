'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let markdownModule;
async function loadMarkdown() {
  if (!markdownModule) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'markdown.js'), 'utf8');
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    markdownModule = import(url);
  }
  return markdownModule;
}

test('assistant analysis and summary tags render as distinct semantic blocks', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const html = renderMarkdown(
    '开头\n<analysis>检查 **日志** 和 `状态`。</analysis>\n<summary>- 已恢复\n- 无错误</summary>',
    { assistantSemanticBlocks: true },
  );

  assert.match(html, /<details class="md-ai-section md-ai-analysis">/);
  assert.match(html, /<span class="md-ai-section-title">分析过程<\/span>/);
  assert.match(html, /<section class="md-ai-section md-ai-summary" role="note" aria-label="结论摘要">/);
  assert.match(html, /<span class="md-ai-section-title">结论摘要<\/span>/);
  assert.match(html, /<strong>日志<\/strong>/);
  assert.match(html, /<code class="md-icode">状态<\/code>/);
  assert.match(html, /<ul class="md-ul"><li>已恢复<\/li><li>无错误<\/li><\/ul>/);
  assert.doesNotMatch(html, /&lt;\/?(?:analysis|summary)&gt;/i);
});

test('semantic tags stay literal unless the caller marks assistant content', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const html = renderMarkdown('<analysis>用户输入</analysis><summary>原样</summary>');

  assert.match(html, /&lt;analysis&gt;用户输入&lt;\/analysis&gt;/);
  assert.match(html, /&lt;summary&gt;原样&lt;\/summary&gt;/);
  assert.doesNotMatch(html, /md-ai-(?:analysis|summary)/);
});

test('semantic-looking tags in inline and fenced code are never interpreted', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const html = renderMarkdown(
    '`<analysis>inline</analysis>`\n```xml\n<summary>fenced</summary>\n```',
    { assistantSemanticBlocks: true },
  );

  assert.match(html, /<code class="md-icode">&lt;analysis&gt;inline&lt;\/analysis&gt;<\/code>/);
  assert.match(html, /<pre class="md-code" data-lang="xml"><code>[\s\S]*&lt;summary&gt;fenced&lt;\/summary&gt;/);
  assert.doesNotMatch(html, /md-ai-(?:analysis|summary)/);
});

test('semantic block bodies remain escaped and malformed tags remain visible', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const safe = renderMarkdown(
    '<summary><img src=x onerror="boom">完成</summary>',
    { assistantSemanticBlocks: true },
  );
  const incomplete = renderMarkdown('<analysis>尚未输出完', { assistantSemanticBlocks: true });

  assert.match(safe, /<section class="md-ai-section md-ai-summary" role="note" aria-label="结论摘要">/);
  assert.match(safe, /&lt;img src=x onerror="boom"&gt;完成/);
  assert.doesNotMatch(safe, /<img\s/i);
  assert.match(incomplete, /&lt;analysis&gt;尚未输出完/);
  assert.doesNotMatch(incomplete, /md-ai-analysis/);
});

test('chat surfaces opt in only on assistant rendering paths', () => {
  const chat = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'chat-view.js'), 'utf8');

  assert.match(chat, /formatContent\(\{ role: 'assistant', content: partial, pending: true \}\)/);
  assert.match(chat, /renderText\(turn\.content \|\| '', turn\.role === 'assistant'\)/);
  assert.match(chat, /renderText\(\(last\.dataset\.raw \|\| ''\) \+ seg\.text, true\)/);
});
