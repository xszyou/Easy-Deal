// Community edition: the phone app relay is not part of this build.

class MobileRelay {
  start() {}
  stop() {}
}

module.exports = {
  MobileRelay,
  startMobileRelay: () => null,
};
