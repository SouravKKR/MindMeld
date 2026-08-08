/**
 * BackfillPaidDeckProvenanceLink
 *
 * One-off backfill: fills `provenanceDeckId` / `sourceDeckId` on paid-deck
 * listings published before those fields existed.
 *
 * Why the link is needed. A listing id is minted fresh by the upload dialog on
 * every upload, while a run's generation provenance is recorded against the
 * deck it produced in the publisher's own library. The two ids are from
 * different spaces and never coincide, so every lookup that went from a listing
 * to its provenance record — the publish review gate, the audit-trail download,
 * the publication stamp — missed silently. New uploads now carry the link;
 * listings already on sale do not, and this fills them in where it can be
 * established.
 *
 * How a match is decided, and where it refuses. The only evidence connecting an
 * old listing to a run is the deck name: provenance stores `deckName`, and the
 * upload dialog pre-fills the listing title from the source deck's name. So a
 * listing is linked only when exactly ONE unlinked provenance record has a
 * title-identical deckName. Anything else — no candidate, several candidates,
 * or a record already claimed by another listing — is reported and skipped.
 *
 * Guessing here would be worse than leaving the field empty. A wrong link would
 * gate one deck's publication on another deck's verification flags and print
 * the wrong audit trail for a paying customer's content, while an empty field
 * simply keeps that listing behaving exactly as it does today (no record found,
 * nothing to verify — see PaidDeckProvenanceLinkResolver).
 *
 * Usage (report first — it changes nothing without --apply):
 *     node Common/Scripts/BackfillPaidDeckProvenanceLink.js
 *     node Common/Scripts/BackfillPaidDeckProvenanceLink.js --apply
 *
 * Reads Dock's environment, so it targets whichever environment Dock is
 * configured for. Run it once per environment. Safe to re-run: listings that
 * already carry a link are never revisited.
 */

const path = require("path");

const dockDirectory = path.join(__dirname, "..", "..", "Dock");
require(path.join(dockDirectory, "node_modules", "dotenv")).config({ path: path.join(dockDirectory, ".env") });

const DatabaseConnector = require(path.join(dockDirectory, "Globals", "Classes", "Database", "DatabaseConnector"));
const DatabaseConstants = require(path.join(dockDirectory, "Globals", "Constants", "DatabaseConstants"));

const bApplyRequested = process.argv.includes("--apply");

/**
 * Normalised for comparison only — never for writing. Titles and deck names are
 * typed by people at different moments, so casing and edge whitespace are not
 * evidence of a different deck. Anything beyond that (punctuation, word order)
 * is left alone: loosening the match further would start inventing links.
 */
function normaliseForComparison(rawValue)
{
    if (typeof rawValue !== "string")
    {
        return "";
    }

    return rawValue.trim().toLowerCase();
}

function buildProvenanceRecordsByDeckName(provenanceRecords)
{
    const recordsByDeckName = new Map();

    for (const provenanceRecord of provenanceRecords)
    {
        const comparisonKey = normaliseForComparison(provenanceRecord.deckName);

        if (comparisonKey.length === 0)
        {
            continue;
        }

        if (!recordsByDeckName.has(comparisonKey))
        {
            recordsByDeckName.set(comparisonKey, []);
        }

        recordsByDeckName.get(comparisonKey).push(provenanceRecord);
    }

    return recordsByDeckName;
}

async function backfillPaidDeckProvenanceLink()
{
    const database = await DatabaseConnector.getDatabase();
    if (database === null)
    {
        console.error("[Backfill] No database connection — check MONGODB_URL. Nothing was changed.");
        process.exitCode = 1;
        return;
    }

    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const provenanceCollection = database.collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

    const unlinkedFilter =
    {
        $or:
        [
            { provenanceDeckId: { $exists: false } },
            { provenanceDeckId: "" },
            { provenanceDeckId: null }
        ]
    };

    const unlinkedListings = await paidDecksCollection
        .find(unlinkedFilter, { projection: { _id: 0, id: 1, title: 1 } })
        .toArray();

    const provenanceRecords = await provenanceCollection
        .find({}, { projection: { _id: 0, deckId: 1, deckName: 1 } })
        .toArray();

    console.log(`[Backfill] Database: ${database.databaseName}`);
    console.log(`[Backfill] Mode: ${bApplyRequested ? "APPLY" : "REPORT ONLY (pass --apply to write)"}`);
    console.log(`[Backfill] Listings with no provenance link: ${unlinkedListings.length}`);
    console.log(`[Backfill] Generation provenance records: ${provenanceRecords.length}`);
    console.log("");

    if (unlinkedListings.length === 0 || provenanceRecords.length === 0)
    {
        console.log("[Backfill] Nothing to link.");
        return;
    }

    // Provenance records already claimed by a linked listing are off the table:
    // one run produced one deck, so a record that already governs a listing
    // cannot also govern a second one.
    const claimedDeckIds = new Set
    (
        (await paidDecksCollection
            .find({ provenanceDeckId: { $nin: ["", null] } }, { projection: { _id: 0, provenanceDeckId: 1 } })
            .toArray())
            .map(listing => listing.provenanceDeckId)
            .filter(deckId => typeof deckId === "string" && deckId.length > 0)
    );

    const recordsByDeckName = buildProvenanceRecordsByDeckName
    (
        provenanceRecords.filter(provenanceRecord => !claimedDeckIds.has(provenanceRecord.deckId))
    );

    const plannedLinks = [];
    const skippedListings = [];

    for (const listing of unlinkedListings)
    {
        const candidateRecords = recordsByDeckName.get(normaliseForComparison(listing.title)) || [];

        if (candidateRecords.length === 1)
        {
            plannedLinks.push({ listing: listing, provenanceRecord: candidateRecords[0] });
            continue;
        }

        skippedListings.push
        ({
            listing: listing,
            reason: candidateRecords.length === 0
                ? "no provenance record with a matching deck name"
                : `${candidateRecords.length} provenance records share that deck name`
        });
    }

    for (const plannedLink of plannedLinks)
    {
        console.log(`[Backfill] LINK   "${plannedLink.listing.title}" (${plannedLink.listing.id}) -> ${plannedLink.provenanceRecord.deckId}`);
    }

    for (const skippedListing of skippedListings)
    {
        console.log(`[Backfill] SKIP   "${skippedListing.listing.title}" (${skippedListing.listing.id}) — ${skippedListing.reason}`);
    }

    console.log("");
    console.log(`[Backfill] Linkable: ${plannedLinks.length}. Skipped: ${skippedListings.length}.`);

    if (skippedListings.length > 0)
    {
        console.log("[Backfill] Skipped listings keep an empty link and behave exactly as they do now.");
        console.log("[Backfill] Link one by hand only if you can confirm which run produced it.");
    }

    if (!bApplyRequested)
    {
        console.log("");
        console.log("[Backfill] Report only — nothing was written. Re-run with --apply to write the links above.");
        return;
    }

    let writtenCount = 0;

    for (const plannedLink of plannedLinks)
    {
        await paidDecksCollection.updateOne(
            { id: plannedLink.listing.id },
            {
                $set:
                {
                    provenanceDeckId: plannedLink.provenanceRecord.deckId,
                    // The listing's content did come from that deck, so both
                    // fields are true here. They diverge only for a sub-deck
                    // sold individually, which this name-based match cannot
                    // identify and therefore never produces.
                    sourceDeckId: plannedLink.provenanceRecord.deckId
                }
            },
        );

        writtenCount++;
    }

    console.log("");
    console.log(`[Backfill] Wrote ${writtenCount} link(s).`);
}

backfillPaidDeckProvenanceLink()
    .catch((backfillError) =>
    {
        console.error("[Backfill] Failed:", backfillError);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
