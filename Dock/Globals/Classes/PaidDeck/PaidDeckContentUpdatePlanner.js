/**
 * PaidDeckContentUpdatePlanner
 *
 * Decides, entity by entity, what happens to a buyer's copy when they accept a
 * publisher's content update.
 *
 * Pure: it takes the buyer's existing rows and the incoming master entities as
 * plain arrays and returns a plan. No database, no clock, no side effects — so
 * the whole decision table is unit-testable, and the confirm dialog can show
 * the buyer real counts by running the same plan as a dry run before anything
 * is written.
 *
 * ── The decision table ────────────────────────────────────────────────────
 *
 * Buyer entity ids are deterministic (sha256 of paidDeckId|userId|instanceId|
 * masterEntityId), so the same master entity always maps to the same buyer row
 * across versions. That is what makes matching possible at all.
 *
 *   same id, same fingerprint      -> CARRIED   keep progress, history and the
 *                                               buyer's own edit
 *   same id, different fingerprint -> RESET     new progress, drop the edit —
 *                                               both described text that is gone
 *   id only in the new version     -> ADDED     seed fresh
 *   id only in the old version     -> REMOVED   delete, cascading its overlays
 */
class PaidDeckContentUpdatePlanner
{
    static OUTCOME_CARRIED = "CARRIED";
    static OUTCOME_RESET = "RESET";
    static OUTCOME_ADDED = "ADDED";
    static OUTCOME_REMOVED = "REMOVED";

    /**
     * @param {Array<object>} existingRows the buyer's current rows, each
     *   { id, fingerprint, progress, lifecycle, history }
     * @param {Array<object>} incomingEntities the new version's entities, each
     *   { id, fingerprint, entityType }
     *
     * @returns {{ carried: Array, reset: Array, added: Array, removed: Array, counts: object }}
     */
    static plan(existingRows, incomingEntities)
    {
        const safeExistingRows = Array.isArray(existingRows) ? existingRows : [];
        const safeIncomingEntities = Array.isArray(incomingEntities) ? incomingEntities : [];

        const existingRowById = new Map();
        for (const existingRow of safeExistingRows)
        {
            if (existingRow && typeof existingRow.id === "string")
            {
                existingRowById.set(existingRow.id, existingRow);
            }
        }

        const carried = [];
        const reset = [];
        const added = [];
        const matchedExistingIds = new Set();

        for (const incomingEntity of safeIncomingEntities)
        {
            if (!incomingEntity || typeof incomingEntity.id !== "string")
            {
                continue;
            }

            const existingRow = existingRowById.get(incomingEntity.id);
            if (!existingRow)
            {
                added.push(incomingEntity);
                continue;
            }

            matchedExistingIds.add(incomingEntity.id);

            // An absent fingerprint on either side means "cannot prove it is
            // unchanged" — a row seeded before fingerprints existed, or an
            // entity type that has none. Resetting is the safe answer: it costs
            // the buyer their progress on that entity, whereas carrying it
            // would attach their scheduling state to text nobody verified.
            const bFingerprintsMatch = Boolean(incomingEntity.fingerprint)
                && Boolean(existingRow.fingerprint)
                && incomingEntity.fingerprint === existingRow.fingerprint;

            if (bFingerprintsMatch)
            {
                carried.push({ incomingEntity: incomingEntity, existingRow: existingRow });
            }
            else
            {
                reset.push({ incomingEntity: incomingEntity, existingRow: existingRow });
            }
        }

        const removed = safeExistingRows.filter(existingRow =>
            existingRow && typeof existingRow.id === "string" && !matchedExistingIds.has(existingRow.id));

        return {
            carried: carried,
            reset: reset,
            added: added,
            removed: removed,
            counts:
            {
                carried: carried.length,
                reset: reset.length,
                added: added.length,
                removed: removed.length
            }
        };
    }
}

module.exports = PaidDeckContentUpdatePlanner;
