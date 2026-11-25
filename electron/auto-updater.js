// Community edition: see updater.js.

const state = {
  initialized: false, available: false, downloading: false, downloaded: false,
  current: null, latest: null, progress: null, error: null,
};

module.exports = {
  init: () => {},
  checkForUpdate: async () => ({ ok: false, error: 'not available in community edition' }),
  downloadUpdate: async () => { throw new Error('not available in community edition'); },
  quitAndInstall: () => {},
  getState: () => ({ ...state }),
  isAvailable: () => false,
};
