// Community (open-source, single-machine) edition switches.
//
// The community build never talks to the EasyDeal backend except for a small
// set of public, read-only endpoints. Everything that needs a license key,
// uploads trading data, or controls this machine remotely is compiled out by
// replacing the module with a stub that reports "not available".

const COMMUNITY_EDITION = true;

// Public read-only endpoints the community build may call. Matched against the
// request path (query string stripped). Anything else is refused locally,
// without touching the network.
// The server's shared knowledge base is written for the commercial client, so
// the community build ships its own manual (bundled-docs/) instead of syncing it.
const PUBLIC_GET_PATHS = [
  /^\/v1\/news$/,
  /^\/v1\/tutorials$/,
  /^\/v1\/sentiment\/?$/,
  /^\/v1\/calendar\/?$/,
];

function isAllowedServerRequest(method, requestPath) {
  if (String(method).toUpperCase() !== 'GET') return false;
  const p = String(requestPath || '').split('?')[0];
  return PUBLIC_GET_PATHS.some((re) => re.test(p));
}

module.exports = { COMMUNITY_EDITION, isAllowedServerRequest };
