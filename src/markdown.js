// Minimal markdown renderer tuned for chat output from Claude.
//
// Why hand-rolled instead of pulling in `marked`: chat content is well-formed,
// the subset we need is small, and we want zero npm runtime deps in the
// renderer. Edge cases will surface; we add them as they come.
//
// Supported (in roughly this order of precedence):
//   - Fenced code blocks   ```lang\n…\n```
//   - Inline code          `code`
//   - Images               ![alt](path "title?")     — also <path> form
//   - Links                [text](url)
//   - Auto-links           bare http(s)://… URLs
//   - Headings             # / ## / ### / #### (line-start)
//   - Bold                 **text**
//   - Italic               *text*
//   - Unordered lists      - / * line groups
//   - Ordered lists        1. / 2. line groups
//   - Blockquotes          > text (multi-line groups)
//   - Horizontal rule      ---
//   - Tables               GFM pipe tables
//   - AI semantic blocks   <analysis> / <summary> (opt-in for assistant text)
//
// Local image paths (no scheme) are rewritten to easydeal-asset://<path> so
// the custom protocol handler can serve them from the workspace dir.

export function renderMarkdown(raw, options = {}) {
  return renderMarkdownInternal(raw, options, 0);
}

function renderMarkdownInternal(raw, options, semanticDepth) {
  if (raw == null) return '';
  let s = String(raw);
  const assistantSemanticBlocks = options?.assistantSemanticBlocks === true && semanticDepth < 8;

  // 1. Extract code so its content survives all subsequent transforms.
  const tokens = [];
  s = s.replace(/```([\w-]*)\r?\n?([\s\S]*?)```/g, (_, lang, body) => {
    tokens.push({ kind: 'fence', lang: lang || '', body });
    return `\x00T${tokens.length - 1}\x00`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, body) => {
    tokens.push({ kind: 'inline', body });
    return `\x00T${tokens.length - 1}\x00`;
  });

  // Some OpenAI-compatible routers return these semantic blocks inside the
  // final text rather than as structured metadata. Protect paired blocks before
  // the generic Markdown passes so lists/headings at their edges stay intact.
  // Code has already been tokenised, so tag-shaped examples inside code are not
  // mistaken for UI directives.
  if (assistantSemanticBlocks) {
    s = s.replace(/<\s*(analysis|summary)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_, kind, body) => {
      tokens.push({ kind: 'semantic', semanticKind: String(kind).toLowerCase(), body });
      return `\x00T${tokens.length - 1}\x00`;
    });
  }

  // 2. Escape HTML in the remaining text. Code tokens are unaffected.
  s = htmlEscape(s);

  // 3. Tables (GFM) — process BEFORE generic line transforms.
  s = s.replace(/(^\|.+\|[ \t]*\n\|[\s|:-]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)+)/gm, (block) => {
    const lines = block.trim().split(/\r?\n/);
    const head = splitRow(lines[0]);
    const align = splitRow(lines[1]).map((c) => {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c))  return 'right';
      return 'left';
    });
    const rows = lines.slice(2).map(splitRow);
    const ths = head.map((c, i) => `<th style="text-align:${align[i] || 'left'}">${c}</th>`).join('');
    const trs = rows.map((row) =>
      `<tr>${row.map((c, i) => `<td style="text-align:${align[i] || 'left'}">${c}</td>`).join('')}</tr>`
    ).join('');
    return `<table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>\n`;
  });

  // 4. Images — handle before links since both start with [
  //    Forms supported:
  //      ![alt](path)
  //      ![alt](path "title")
  //      ![alt](<path>)
  //      ![alt](<path with spaces>)
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+(?:&quot;|&#39;)[^)]*?(?:&quot;|&#39;))?\s*\)/g,
    (_, alt, src) => imageHtml(alt, src));

  // 5. Links
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+(?:&quot;|&#39;)[^)]*?(?:&quot;|&#39;))?\s*\)/g,
    (_, text, href) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`);

  // 6. Bare URLs → anchors (only if not already inside an href)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>)"]+)/g,
    (_, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

  // 7. Headings (must be at start of line, after newline tokenisation)
  s = s.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  s = s.replace(/^###\s+(.+)$/gm,  '<h3 class="md-h3">$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm,   '<h2 class="md-h2">$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm,    '<h1 class="md-h1">$1</h1>');

  // 8. Bold (greedy-ish but stops at newlines)
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

  // 9. Italic — only when * is surrounded by word boundaries / spaces
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,!?:;)\]]|$)/g, '$1<em>$2</em>');

  // 10. Unordered lists — group consecutive bullet lines.
  s = s.replace(/((?:^[ \t]*[-*][ \t]+.+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*[-*][ \t]+/, ''))
      .map((t) => `<li>${t}</li>`).join('');
    return `<ul class="md-ul">${items}</ul>\n`;
  });

  // 11. Ordered lists
  s = s.replace(/((?:^[ \t]*\d+\.[ \t]+.+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*\d+\.[ \t]+/, ''))
      .map((t) => `<li>${t}</li>`).join('');
    return `<ol class="md-ol">${items}</ol>\n`;
  });

  // 12. Blockquotes — group consecutive > lines.
  s = s.replace(/((?:^>[ \t]?.*(?:\n|$))+)/gm, (m) => {
    const inner = m.trim().split(/\r?\n/)
      .map((l) => l.replace(/^>[ \t]?/, '')).join('<br>');
    return `<blockquote class="md-quote">${inner}</blockquote>\n`;
  });

  // 13. Horizontal rules
  s = s.replace(/^[ \t]*-{3,}[ \t]*$/gm, '<hr class="md-hr">');

  // 14. Newlines → <br>.
  s = s.replace(/\r?\n/g, '<br>');

  // 15. Restore code and semantic tokens.
  s = s.replace(/\x00T(\d+)\x00/g, (_, i) => {
    const t = tokens[+i];
    if (t.kind === 'semantic') {
      const sourceBody = restoreCodeTokenSources(t.body, tokens);
      const renderedBody = renderMarkdownInternal(sourceBody, options, semanticDepth + 1);
      return semanticBlockHtml(t.semanticKind, renderedBody);
    }
    const escapedBody = htmlEscape(t.body);
    if (t.kind === 'fence') {
      const lang = t.lang ? ` data-lang="${attrEscape(t.lang)}"` : '';
      return `<pre class="md-code"${lang}><code>${escapedBody}</code></pre>`;
    }
    return `<code class="md-icode">${escapedBody}</code>`;
  });

  // 16. Strip line-break elements next to blocks after token restoration, so
  //     fenced code and semantic cards do not acquire accidental blank rows.
  s = s.replace(/<br>(?=<(?:h[1-6]|ul|ol|blockquote|hr|table|pre|details|section)[\s>])/g, '');
  s = s.replace(/(<\/(?:h[1-6]|ul|ol|blockquote|table|pre|details|section)>|<hr[^>]*>)<br>/g, '$1');

  return s;
}

// ---------- helpers ----------

function semanticBlockHtml(kind, body) {
  const content = String(body || '').trim();
  if (String(kind).toLowerCase() === 'analysis') {
    return `<details class="md-ai-section md-ai-analysis"><summary class="md-ai-section-head"><span class="md-ai-section-icon" aria-hidden="true">✦</span><span class="md-ai-section-title">分析过程</span><span class="md-ai-section-hint" aria-hidden="true"></span></summary><div class="md-ai-section-body">${content}</div></details>`;
  }
  return `<section class="md-ai-section md-ai-summary" role="note" aria-label="结论摘要"><div class="md-ai-section-head"><span class="md-ai-section-icon" aria-hidden="true">✓</span><span class="md-ai-section-title">结论摘要</span></div><div class="md-ai-section-body">${content}</div></section>`;
}

function restoreCodeTokenSources(raw, tokens) {
  return String(raw || '').replace(/\x00T(\d+)\x00/g, (marker, i) => {
    const token = tokens[+i];
    if (!token) return marker;
    if (token.kind === 'fence') return `\`\`\`${token.lang || ''}\n${token.body}\`\`\``;
    if (token.kind === 'inline') return `\`${token.body}\``;
    return marker;
  });
}

function imageHtml(alt, src) {
  let out = src;
  if (!/^(https?|data|file|easydeal-asset|blob):/i.test(src)) {
    out = `easydeal-asset:///${src.replace(/^\.?\/+/, '')}`;
  }
  return `<img src="${attrEscape(out)}" alt="${attrEscape(alt || '')}" class="md-img" loading="lazy" data-src="${attrEscape(out)}">`;
}

function splitRow(line) {
  // Strip leading | and trailing |, split, trim each cell.
  const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return inner.split('|').map((c) => c.trim());
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attrEscape(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
