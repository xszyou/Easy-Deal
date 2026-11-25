// Community edition: marketplace, leaderboard, copy-trade signals, cloud stats,
// remote control grants and IM all live on the EasyDeal backend and are not
// part of this build.

const { rejectingApi } = require('./_community-stub');

module.exports = rejectingApi([
  'remoteRequestGrant', 'remoteListGrants', 'remoteDecide', 'remoteRevoke', 'remoteCall',
  'listListings', 'listMyListings', 'getListing', 'getListingStats',
  'submitListing', 'withdrawListing', 'setListingPrice',
  'createOrder', 'listMyOrders', 'listOrdersForListing',
  'approveOrder', 'rejectOrder',
  'sellerInbox', 'downloadEx5',
  'uploadStats', 'myStats',
  'uploadRawBalance', 'uploadRawDeals', 'uploadRawEaFloating',
  'getRawBalanceLatest', 'getRawDealsMaxId',
  'getMetric', 'explainMetric', 'getPendingCommands', 'reportCommandResult',
  'setAnchor', 'listAnchors',
  'uploadDiagnostic',
  'imOpenConversation', 'imOpenWithSupport', 'imListConversations',
  'imGetMessages', 'imSendMessage', 'imMarkRead',
  'releaseNewVersion', 'listingVersions', 'listingBuyerStats',
  'setSellerStatsOptOut', 'getSellerStatsOptOut',
  'getProfile', 'setDisplayName',
  'clearLeaderboardRecords',
]);
