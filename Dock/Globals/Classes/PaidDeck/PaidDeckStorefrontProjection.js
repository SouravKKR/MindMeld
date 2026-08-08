/**
 * PaidDeckStorefrontProjection
 *
 * Removes the publisher-internal fields from a paid-deck document before it is
 * sent to a buyer.
 *
 * The storefront endpoints all hand back the stored document with only `_id`
 * removed, so anything added to the `paidDecks` schema reaches every visitor by
 * default. `sourceDeckId` and `provenanceDeckId` are administrative plumbing:
 * they name decks inside the publisher's own library, exist purely so the
 * review gate and the audit trail can find a listing's generation record, and
 * mean nothing to a buyer. Shipping them would also let anyone browsing the
 * catalogue tell which listings came from the same source deck or the same
 * generation run — an inference about how the catalogue is produced that no
 * buyer-facing feature needs.
 *
 * Deliberately narrow. It strips exactly the two link fields rather than
 * allow-listing the whole storefront payload, because an allow-list here would
 * silently drop any field a future storefront feature adds and the failure
 * would show up as a blank spot in the UI rather than an error.
 */
class PaidDeckStorefrontProjection
{
    static PUBLISHER_INTERNAL_FIELDS = ["sourceDeckId", "provenanceDeckId"];

    /**
     * Returns a copy of the document without the publisher-internal fields.
     * Copies rather than mutating, so a caller holding the document for another
     * purpose (pricing, audience checks) is unaffected.
     *
     * @param {object} paidDeckDocument
     * @returns {object}
     */
    static forBuyer(paidDeckDocument)
    {
        if (!paidDeckDocument || typeof paidDeckDocument !== "object")
        {
            return paidDeckDocument;
        }

        const buyerFacingDocument = { ...paidDeckDocument };

        for (const internalFieldName of PaidDeckStorefrontProjection.PUBLISHER_INTERNAL_FIELDS)
        {
            delete buyerFacingDocument[internalFieldName];
        }

        return buyerFacingDocument;
    }
}

module.exports = PaidDeckStorefrontProjection;
