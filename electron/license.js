// Community edition: there is no license server. The app always starts and
// reports a fixed local identity so per-user local state (onboarding progress
// and the like) still has a stable key. No session token is ever issued, so
// every code path that needs the EasyDeal backend skips itself.

const COMMUNITY_KEY = 'community';

function getStatus() {
  return {
    enabled: false,
    community: true,
    logged_in: true,
    key: COMMUNITY_KEY,
    key_masked: COMMUNITY_KEY,
    display_name: null,
    machine_id: null,
    machine_id_short: null,
    expires_at: null,
    is_trial: false,
    tier: null,
    machine_bound: false,
    server: null,
  };
}

module.exports = {
  ensureLoggedIn: async () => true,
  closeGateIfOpen: () => {},
  setMainWindow: () => {},
  setOnLoginSuccess: () => {},
  getStatus,
  stopHeartbeat: () => {},
  logout: async () => ({ ok: false, error: 'not available in community edition' }),
  _activeToken: () => null,
  heartbeatStatus: () => ({ active: false, fail_count: 0, interval_sec: 0 }),
};
