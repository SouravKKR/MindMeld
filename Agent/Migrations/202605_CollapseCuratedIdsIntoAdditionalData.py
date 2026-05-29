"""
One-shot migration: collapse the three deck-side curated-ID arrays into
self-describing `additionalData` on each StudyMaterial.

Before this migration:
  deck.data.additionalData.curatedStudyMaterialIds        = [...]
  deck.data.additionalData.pendingBatchReviewMaterialIds  = [...]
  deck.data.additionalData.archivedCuratedStudyMaterialIds = [...]

After this migration:
  Each referenced study material carries:
    data.additionalData.bCurated               = true
    data.additionalData.batchReviewState       = "LIVE" | "PENDING_REVIEW" | "ARCHIVED"
    data.additionalData.topicStrength          = "WEAK"  (best-effort default)
    data.additionalData.topicName              = ""     (lost from the old format)
    data.additionalData.generatedForAnalysisAt = ""     (lost from the old format)
  Decks have all three legacy arrays $unset.

Sync-collection docs are wrapped {userId, data: {...}, serverUpdatedAt}
by the sync layer (Dock SyncQueryEngine.bulkUpsert), so every selector
and update path uses the `data.` prefix.

Run once:
    python Agent/Migrations/202605_CollapseCuratedIdsIntoAdditionalData.py

Safe to re-run: it is idempotent — materials already carrying the
`bCurated` flag are left alone, and missing legacy arrays are skipped.
"""

import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

_AGENT_ROOT = Path(__file__).resolve().parents[1]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from dotenv import load_dotenv

from Globals.Classes.Analysis.CuratedStudyMaterialFields import CuratedStudyMaterialFields
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.CuratedBatchReviewStates import CuratedBatchReviewStates
from Globals.Enumerations.TopicStrength import TopicStrength


LEGACY_LIVE_FIELD       = "curatedStudyMaterialIds"
LEGACY_PENDING_FIELD    = "pendingBatchReviewMaterialIds"
LEGACY_ARCHIVED_FIELD   = "archivedCuratedStudyMaterialIds"


def _flag_payload(batch_review_state: CuratedBatchReviewStates, now_datetime: datetime) -> dict:
    """Returns the `data.additionalData.*` $set fragment for a curated material."""
    return {
        f"data.additionalData.{CuratedStudyMaterialFields.B_CURATED}":                 True,
        f"data.additionalData.{CuratedStudyMaterialFields.BATCH_REVIEW_STATE}":        batch_review_state.name,
        f"data.additionalData.{CuratedStudyMaterialFields.TOPIC_STRENGTH}":            TopicStrength.WEAK.name,
        f"data.additionalData.{CuratedStudyMaterialFields.TOPIC_NAME}":                "",
        f"data.additionalData.{CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT}": "",
        "data.lifecycle.lastModified":                                                 now_datetime,
        "serverUpdatedAt":                                                             now_datetime,
    }


async def _apply_to_materials(study_materials_collection, material_ids: list[str], batch_review_state: CuratedBatchReviewStates) -> int:
    """Flags every material in the supplied list with the given batch-review state. Returns the modified count."""
    if not material_ids:
        return 0

    now_datetime = datetime.now(timezone.utc)
    result = await asyncio.to_thread(
        study_materials_collection.update_many,
        {"data.id": {"$in": material_ids}},
        {"$set": _flag_payload(batch_review_state, now_datetime)},
    )
    return getattr(result, "modified_count", 0)


async def _migrate_decks(deck_collection, study_materials_collection) -> dict:
    """
    Walks every deck that still carries any of the three legacy arrays,
    flags the referenced materials accordingly, then $unsets the arrays.
    Returns a small summary dict for the final printout.
    """
    counters = {
        "decks_processed":            0,
        "live_materials_flagged":     0,
        "pending_materials_flagged":  0,
        "archived_materials_flagged": 0,
    }

    legacy_match = {"$or": [
        {f"data.additionalData.{LEGACY_LIVE_FIELD}":     {"$exists": True}},
        {f"data.additionalData.{LEGACY_PENDING_FIELD}":  {"$exists": True}},
        {f"data.additionalData.{LEGACY_ARCHIVED_FIELD}": {"$exists": True}},
    ]}

    decks_cursor = await asyncio.to_thread(
        list,
        deck_collection.find(legacy_match, {"_id": 0, "data.id": 1, "data.additionalData": 1}),
    )

    for deck_doc in decks_cursor:
        deck_data       = deck_doc.get("data") or {}
        additional_data = deck_data.get("additionalData") or {}

        live_ids     = additional_data.get(LEGACY_LIVE_FIELD)     if isinstance(additional_data.get(LEGACY_LIVE_FIELD),     list) else []
        pending_ids  = additional_data.get(LEGACY_PENDING_FIELD)  if isinstance(additional_data.get(LEGACY_PENDING_FIELD),  list) else []
        archived_ids = additional_data.get(LEGACY_ARCHIVED_FIELD) if isinstance(additional_data.get(LEGACY_ARCHIVED_FIELD), list) else []

        counters["live_materials_flagged"]     += await _apply_to_materials(study_materials_collection, live_ids,     CuratedBatchReviewStates.LIVE)
        counters["pending_materials_flagged"]  += await _apply_to_materials(study_materials_collection, pending_ids,  CuratedBatchReviewStates.PENDING_REVIEW)
        counters["archived_materials_flagged"] += await _apply_to_materials(study_materials_collection, archived_ids, CuratedBatchReviewStates.ARCHIVED)

        now_datetime = datetime.now(timezone.utc)
        await asyncio.to_thread(
            deck_collection.update_one,
            {"data.id": deck_data.get("id")},
            {
                "$unset":
                {
                    f"data.additionalData.{LEGACY_LIVE_FIELD}":     "",
                    f"data.additionalData.{LEGACY_PENDING_FIELD}":  "",
                    f"data.additionalData.{LEGACY_ARCHIVED_FIELD}": "",
                },
                "$set":
                {
                    "data.lifecycle.lastModified": now_datetime,
                    "serverUpdatedAt":             now_datetime,
                },
            },
        )

        counters["decks_processed"] += 1

    return counters


async def run() -> int:
    load_dotenv()

    database = await DatabaseConnector.get_database()
    if database is None:
        print("[Migration] No database connection — aborting.")
        return 1

    deck_collection            = database[DatabaseConstants.DECKS_COLLECTION]
    study_materials_collection = database[DatabaseConstants.STUDY_MATERIALS_COLLECTION]

    counters = await _migrate_decks(deck_collection, study_materials_collection)

    print(
        "[Migration] Collapsed legacy curated-ID arrays: "
        f"{counters['decks_processed']} deck(s) processed, "
        f"{counters['live_materials_flagged']} LIVE, "
        f"{counters['pending_materials_flagged']} PENDING_REVIEW, "
        f"{counters['archived_materials_flagged']} ARCHIVED material(s) flagged."
    )

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
