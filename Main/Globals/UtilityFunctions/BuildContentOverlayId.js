/**
 * Builds the deterministic id of a content-overlay record.
 *
 * The id is derived from what the overlay targets rather than randomly
 * generated, and that is load-bearing: two devices editing the same field of
 * the same card must converge on ONE record so the sync layer's
 * last-write-wins on lifecycle.lastModified picks a winner. A random id per
 * edit would instead accumulate a new record per device per edit, with no way
 * to tell which one the reader should use.
 *
 * The separator cannot appear in an entity id (they are UUIDs), so an id built
 * here can never collide with another entity's. That matters beyond tidiness:
 * the server's deletions collection is keyed on (userId, entityId) with no
 * entityType, so a collision between an overlay id and any other entity id
 * would make one deletion tombstone silently delete the other.
 *
 * @param {string} targetEntityId the card / study material the overlay belongs to
 * @param {number} fieldKey a ContentOverlayFields enum value
 *
 * @returns {string} the overlay record id
 */
export function buildContentOverlayId(targetEntityId, fieldKey)
{
    return `${targetEntityId}::${fieldKey}`;
}

export default buildContentOverlayId;
