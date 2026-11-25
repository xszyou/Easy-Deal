// Community edition: automatic updates from the commercial release channel are
// disabled, so community users are never offered a commercial build. New
// versions are published on the open-source repository.

function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = {
  cmpVersion,
  downloadInstaller: async () => { throw new Error('not available in community edition'); },
  launchAndQuit: async () => { throw new Error('not available in community edition'); },
  pruneOldInstallers: async () => {},
  updatesDir: () => null,
};
