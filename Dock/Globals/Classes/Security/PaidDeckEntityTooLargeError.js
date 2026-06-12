/**
 * Thrown when a single paid-deck entity (card / study material / mock test /
 * deck node) serialises to more than Mongo's 16MB per-document limit — the
 * one ceiling the per-entity storage model can't get under (a normal deck
 * hits the exact same limit for such an entity). Carries the entityId so the
 * upload endpoint can surface a clear message instead of a raw BSON error.
 */
class PaidDeckEntityTooLargeError extends Error
{
    constructor(entityId, sizeBytes)
    {
        super(`Paid-deck entity "${entityId}" is too large to store (${sizeBytes} bytes; the per-document limit is 16MB). Reduce embedded images in that entity.`);
        this.name = "PaidDeckEntityTooLargeError";
        this.entityId = entityId;
        this.sizeBytes = sizeBytes;
    }
}

module.exports = PaidDeckEntityTooLargeError;
