class PaidDeckShareConstants
{
    static DEEP_LINK_ROUTE_PATH = '/PaidDeck';
    static DEEP_LINK_DECK_ID_QUERY_PARAMETER = 'id';
    static PENDING_DECK_ID_COOKIE_NAME = 'pendingPaidDeckId';
    static PENDING_DECK_ID_COOKIE_MAX_AGE_SECONDS = 600;
    static DETAILS_ENDPOINT_PATH = '/PaidDecks/Details';
    static QR_MODULE_TARGET_PIXEL_SIZE = 1024;
    static QR_QUIET_ZONE_MODULES = 4;
}

module.exports = PaidDeckShareConstants;
