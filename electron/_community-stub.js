// Shared helper for community-edition stubs: every listed method rejects with
// the same offline-shaped error the real HTTP client uses, so existing callers
// fall into their "server unreachable" handling.

function unavailableError() {
  const err = new Error('not available in community edition');
  err.status = 0;
  err.offline = true;
  err.disabled = true;
  return err;
}

function rejectingApi(names) {
  const api = {};
  for (const name of names) api[name] = async () => { throw unavailableError(); };
  return api;
}

module.exports = { unavailableError, rejectingApi };
