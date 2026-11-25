// Chat attachment store. Files dropped / pasted / picked by the user land
// in <workspace>/.attachments/<draftId>/ during composition. After send, we
// leave them in place — the prompt sent to Claude Code references the
// relative path (e.g. .attachments/draft_abc/screenshot.png), so Claude can
// Read them via its standard file tools (image files render visually).
//
// Each draftId scopes one chat turn's attachments. UI calls newDraftId()
// when the composer first becomes "dirty" with an attachment, then send()
// passes the draftId so the chat-session can list and reference its files.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file

class Attachments {
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
    this.dir = path.join(workspaceDir, '.attachments');
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  newDraftId() {
    return `draft_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  }

  _draftDir(draftId) {
    if (!/^[a-z0-9_]+$/i.test(String(draftId))) throw new Error('invalid draft id');
    return path.join(this.dir, String(draftId));
  }

  async ensureDraft(draftId) {
    const dir = this._draftDir(draftId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async saveBuffer(draftId, filename, buffer) {
    if (!buffer || !buffer.byteLength) throw new Error('empty buffer');
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(`文件过大 (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)，限制 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    }
    const dir = await this.ensureDraft(draftId);
    const safeName = sanitizeFilename(filename) || `pasted-${Date.now()}.bin`;
    const dest = await this._unique(path.join(dir, safeName));
    await fs.writeFile(dest, buffer);
    return this._describe(draftId, dest, await fs.stat(dest));
  }

  async copyFromPath(draftId, srcPath) {
    const st = await fs.stat(srcPath);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大 (${(st.size / 1024 / 1024).toFixed(1)}MB)，限制 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    }
    const dir = await this.ensureDraft(draftId);
    const safeName = sanitizeFilename(path.basename(srcPath)) || `file-${Date.now()}`;
    const dest = await this._unique(path.join(dir, safeName));
    await fs.copyFile(srcPath, dest);
    return this._describe(draftId, dest, await fs.stat(dest));
  }

  async listDraft(draftId) {
    const dir = this._draftDir(draftId);
    let entries;
    try { entries = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const name of entries) {
      try {
        const st = await fs.stat(path.join(dir, name));
        if (st.isFile()) {
          out.push(this._describe(draftId, path.join(dir, name), st));
        }
      } catch {}
    }
    return out;
  }

  async removeFromDraft(draftId, name) {
    const dir = this._draftDir(draftId);
    const safe = sanitizeFilename(String(name));
    if (!safe) throw new Error('invalid name');
    const target = path.join(dir, safe);
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
      throw new Error('path escapes attachments dir');
    }
    await fs.unlink(target);
    return { ok: true };
  }

  async clearDraft(draftId) {
    const dir = this._draftDir(draftId);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }

  _describe(draftId, absPath, st) {
    const name = path.basename(absPath);
    return {
      name,
      relPath: `.attachments/${draftId}/${name}`, // POSIX, used in prompts
      absPath,
      size: st.size,
      mtime: st.mtimeMs,
      kind: detectKind(name),
    };
  }

  async _unique(p) {
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    const dir = path.dirname(p);
    let i = 0;
    while (true) {
      const candidate = i === 0 ? p : path.join(dir, `${base} (${i})${ext}`);
      try { await fs.access(candidate); i++; }
      catch { return candidate; }
    }
  }
}

function sanitizeFilename(name) {
  // Strip path components and characters disallowed on Windows.
  const base = path.basename(String(name || ''));
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}

function detectKind(name) {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) return 'image';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(mq[5h]|set|ex5)$/.test(lower)) return 'mq5';
  if (/\.(json|md|markdown|txt|csv|log|ya?ml|html?|xml|js|ts|py|sh|conf|ini)$/.test(lower)) return 'text';
  return 'file';
}

module.exports = { Attachments, MAX_FILE_BYTES };
