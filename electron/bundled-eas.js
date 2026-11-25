// Community edition ships GMarket v1.082 (compiled .ex5 + strategy notes).
// On first launch it is copied into <workspace>/strategies/ so it shows up on
// the 策略 tab like any user-added strategy. The copy happens once: the marker
// file remembers what was installed, so a user who deletes the strategy does
// not get it back on the next launch.

const fs = require('node:fs/promises');
const path = require('node:path');

const BUNDLED = [
  { id: 'gmarket-1.082', files: ['GMarket.ex5', 'GMarket.md'] },
];

async function installBundledEas({ bundledDir, workspaceDir, dataDir, log = () => {} }) {
  const markerPath = path.join(dataDir, 'bundled-eas.json');
  let installed = {};
  try { installed = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch {}

  const strategiesDir = path.join(workspaceDir, 'strategies');
  await fs.mkdir(strategiesDir, { recursive: true });

  const done = [];
  for (const ea of BUNDLED) {
    if (installed[ea.id]) continue;
    for (const name of ea.files) {
      const src = path.join(bundledDir, name);
      const dst = path.join(strategiesDir, name);
      try { await fs.access(dst); continue; } catch {}
      await fs.copyFile(src, dst);
    }
    installed[ea.id] = new Date().toISOString();
    done.push(ea.id);
  }
  if (done.length) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify(installed, null, 2), 'utf8');
    log(`installed bundled EAs: ${done.join(', ')}`);
  }
  return done;
}

// The bundled docs (user manual, ML4T reading guide) are mirrored into
// <workspace>/knowledge/ on every launch, writing only files whose content
// changed, so the AI reads the community-edition docs and a newer install
// replaces older copies. Files the user added to knowledge/ are left alone.
async function syncBundledDocs({ docsDir, workspaceDir, log = () => {} }) {
  const knowledgeDir = path.join(workspaceDir, 'knowledge');
  const written = [];
  async function walk(rel) {
    for (const ent of await fs.readdir(path.join(docsDir, rel), { withFileTypes: true })) {
      const childRel = path.join(rel, ent.name);
      if (ent.isDirectory()) { await walk(childRel); continue; }
      if (!ent.isFile()) continue;
      const content = await fs.readFile(path.join(docsDir, childRel));
      const dst = path.join(knowledgeDir, childRel);
      try {
        if ((await fs.readFile(dst)).equals(content)) continue;
      } catch {}
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, content);
      written.push(childRel);
    }
  }
  await walk('');
  if (written.length) log(`synced ${written.length} bundled doc(s) into ${knowledgeDir}`);
  return written;
}

// Earlier builds synced the commercial client's help docs from the server into
// knowledge/ and recorded them in .kb_meta.json. Remove those files so the AI
// does not read about features the community edition does not have. Files the
// user uploaded are not in the meta file and are kept.
async function removeServerSyncedDocs({ workspaceDir, log = () => {} }) {
  const knowledgeDir = path.join(workspaceDir, 'knowledge');
  const metaPath = path.join(knowledgeDir, '.kb_meta.json');
  let meta;
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { return []; }
  const items = meta && meta.items ? meta.items : {};
  const removed = [];
  for (const it of Object.values(items)) {
    const name = it && it.local_filename;
    if (!name || name !== path.basename(name)) continue;
    try { await fs.unlink(path.join(knowledgeDir, name)); removed.push(name); } catch {}
  }
  if (Object.keys(items).length) {
    meta.items = {};
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }
  if (removed.length) log(`removed server-synced docs: ${removed.join(', ')}`);
  return removed;
}

module.exports = { installBundledEas, syncBundledDocs, removeServerSyncedDocs, BUNDLED };
