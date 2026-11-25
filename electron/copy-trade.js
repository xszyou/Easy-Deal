// Community edition: copy trading runs through the EasyDeal backend and is not
// part of this build.

const { rejectingApi } = require('./_community-stub');

module.exports = rejectingApi([
  'requestFollow', 'listMySubscriptions', 'pauseAsFollower', 'resumeAsFollower',
  'listRequestsForMe', 'listMyFollowers', 'approveRequest', 'rejectRequest',
  'pauseAsAuthor', 'resumeAsAuthor', 'revoke', 'streamStatus',
]);
