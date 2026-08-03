import datetime
import time
import uuid
from typing import Any, Optional

import numpy

from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.SupportTicketStatus import SupportTicketStatus
from Globals.Enumerations.SupportTicketReportStatus import SupportTicketReportStatus


class SupportTicketQueryEngine:
    """
    Agent-side persistence for the support-ticket deduplication workflow.

    Owns the half of the subsystem that only the Agent can perform: embedding a
    report, searching existing tickets for a semantic match, and either folding the
    report into one or creating a new ticket. Dock owns submission, the reporter's
    status view, and the resolve / decline lifecycle.

    Mirrors EmbeddingsQueryEngine's Atlas-first / brute-force-fallback shape. That
    fallback is not hypothetical here: production runs a self-hosted MongoDB
    Community server with no search node, so $vectorSearch raises and the cosine
    scan is the live path. It is inexpensive because the candidate set is
    pre-narrowed to ACTIVE tickets only.
    """

    # Name of the Atlas Vector Search index on the supportTickets collection.
    # Created by Dock's DatabaseConnector (#setupCollections) — keep this literal
    # in sync with DatabaseConnector.SUPPORT_TICKETS_VECTOR_INDEX_NAME.
    VECTOR_INDEX_NAME = "supportTicketsVectorSearch"

    # The deduplication mutex. A single lease-held document, id'd by a constant so
    # every worker contends for the same lock.
    DEDUPLICATION_LOCK_ID = "supportTicketDeduplication"

    # The lease MUST comfortably outlast the critical section it protects, which is
    # a cold SentenceTransformer load (~550 MB, several seconds on a loaded box)
    # plus an embedding pass plus a Gemini call that may retry twice. A lease that
    # expires mid-run is worse than no lock: a second worker takes it, searches
    # before the first has written its ticket, and both create one — exactly the
    # duplicate this mutex exists to prevent. Ten minutes is far beyond any real
    # run; the TTL index is only a backstop for a worker that died outright.
    DEDUPLICATION_LOCK_LEASE_SECONDS = 600

    @staticmethod
    async def get_report(report_id: str) -> Optional[dict[str, Any]]:
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION]
        return collection.find_one({ "id": report_id }, { "_id": 0 })

    @staticmethod
    async def vector_search_active_tickets(query_embedding: list[float], top_k: int = 5) -> list[dict[str, Any]]:
        """
        The top-k ACTIVE tickets most semantically similar to the query embedding.

        Restricted to ACTIVE deliberately: a report that resembles a long-closed
        ticket opens a new one instead of reviving it. We cannot tell from
        similarity alone whether an old defect was reintroduced, and reopening
        would drag the closed ticket's already-notified, already-compensated
        reporters into a second resolution round.
        """
        if not query_embedding:
            return []

        top_k = max(0, int(top_k))
        if top_k == 0:
            return []

        tickets_collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKETS_COLLECTION]

        try:
            return SupportTicketQueryEngine.__atlas_vector_search(tickets_collection, query_embedding, top_k)
        except Exception as vector_search_error:
            print(f"[SupportTicketQueryEngine] Atlas vector search unavailable, falling back to brute-force cosine: {vector_search_error}")
            return SupportTicketQueryEngine.__brute_force_vector_search(tickets_collection, query_embedding, top_k)

    @staticmethod
    def __atlas_vector_search(tickets_collection, query_embedding: list[float], top_k: int) -> list[dict[str, Any]]:
        """
        Approximate-nearest-neighbour retrieval via $vectorSearch, pre-filtered on
        status so closed tickets never enter the candidate pool. Raises when the
        search index is not queryable, which is what drives the fallback.
        """
        pipeline = [
            {
                "$vectorSearch":
                {
                    "index": SupportTicketQueryEngine.VECTOR_INDEX_NAME,
                    "path": "embedding",
                    "queryVector": [float(value) for value in query_embedding],
                    "numCandidates": max(top_k * 20, 100),
                    "limit": top_k,
                    "filter": { "status": int(SupportTicketStatus.ACTIVE) },
                }
            },
            {
                "$project":
                {
                    "_id": 0,
                    "id": 1,
                    "title": 1,
                    "description": 1,
                    "issueType": 1,
                    "aspects": 1,
                    "reportCount": 1,
                    "similarity": { "$meta": "vectorSearchScore" },
                }
            },
        ]

        return list(tickets_collection.aggregate(pipeline))

    @staticmethod
    def __brute_force_vector_search(tickets_collection, query_embedding: list[float], top_k: int) -> list[dict[str, Any]]:
        """
        Fallback path, and in practice the production path. Loads every ACTIVE
        ticket's vector and scores cosine in-process. Linear in the number of open
        tickets, which is a number that stays small precisely because this
        subsystem deduplicates them.
        """
        candidate_documents = list(tickets_collection.find(
            {
                "status": int(SupportTicketStatus.ACTIVE),
                "embedding": { "$exists": True, "$ne": [] },
            },
            { "_id": 0, "id": 1, "title": 1, "description": 1, "issueType": 1, "aspects": 1, "reportCount": 1, "embedding": 1 }
        ))

        if not candidate_documents:
            return []

        query_vector = numpy.asarray(query_embedding, dtype=numpy.float32)
        query_norm = numpy.linalg.norm(query_vector)
        if query_norm == 0.0:
            return []

        scored_tickets = []
        for candidate_document in candidate_documents:
            candidate_vector = numpy.asarray(candidate_document["embedding"], dtype=numpy.float32)
            candidate_norm = numpy.linalg.norm(candidate_vector)
            if candidate_norm == 0.0:
                continue

            similarity = float(numpy.dot(query_vector, candidate_vector) / (query_norm * candidate_norm))
            scored_tickets.append(
            {
                "id": candidate_document["id"],
                "title": candidate_document.get("title", ""),
                "description": candidate_document.get("description", ""),
                "issueType": candidate_document.get("issueType", 0),
                "aspects": candidate_document.get("aspects", []),
                "reportCount": candidate_document.get("reportCount", 0),
                "similarity": similarity,
            })

        scored_tickets.sort(key=lambda entry: entry["similarity"], reverse=True)
        return scored_tickets[:top_k]

    @staticmethod
    async def create_ticket(ticket_document: dict[str, Any]) -> None:
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKETS_COLLECTION]
        collection.insert_one(ticket_document)

    @staticmethod
    async def merge_report_into_ticket(ticket_id: str, updated_fields: dict[str, Any], new_aspect: Optional[dict[str, Any]]) -> bool:
        """
        Folds one report into an existing ticket: bumps the reporter counter, sets
        the refreshed title / description / embedding, and appends the new aspect
        when the report actually contributed something not already covered.

        Guarded on the ticket still being ACTIVE, so a ticket an admin resolved
        while this workflow was mid-flight is not silently reopened by a merge.
        Returns False in that case and the caller creates a fresh ticket instead.
        """
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKETS_COLLECTION]

        update_operations: dict[str, Any] = {
            "$inc": { "reportCount": 1 },
            "$set": updated_fields,
        }

        if new_aspect is not None:
            update_operations["$push"] = { "aspects": new_aspect }

        result = collection.update_one(
            { "id": ticket_id, "status": int(SupportTicketStatus.ACTIVE) },
            update_operations
        )

        return result.matched_count > 0

    @staticmethod
    async def mark_report_grouped(report_id: str, ticket_id: str) -> None:
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION]
        collection.update_one(
            { "id": report_id },
            {
                "$set":
                {
                    "ticketId": ticket_id,
                    "groupingStatus": int(SupportTicketReportStatus.GROUPED),
                    "groupedAt": int(time.time() * 1000),
                }
            }
        )

    @staticmethod
    async def mark_report_grouping_failed(report_id: str) -> None:
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION]
        collection.update_one(
            { "id": report_id },
            { "$set": { "groupingStatus": int(SupportTicketReportStatus.GROUPING_FAILED) } }
        )

    @staticmethod
    async def acquire_deduplication_lock() -> Optional[str]:
        """
        Takes the deduplication mutex, returning an owner token on success and None
        when another worker holds a live lease.

        Needed because two reports of the same problem submitted at the same moment
        would otherwise each search before the other had written its ticket, and
        both would conclude "no match" — producing exactly the duplicate the whole
        feature exists to prevent. Submission volume is capped at two reports per
        user per day, so serialising this step costs nothing.

        The upsert is the atomic operation: it only succeeds when no document
        exists or the existing lease has expired, and a duplicate-key error from a
        concurrent winner is the "someone else has it" signal.
        """
        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKET_DEDUPLICATION_LOCKS_COLLECTION]

        owner_token = str(uuid.uuid4())
        now_milliseconds = int(time.time() * 1000)
        expires_at_milliseconds = now_milliseconds + (SupportTicketQueryEngine.DEDUPLICATION_LOCK_LEASE_SECONDS * 1000)

        try:
            result = collection.update_one(
                {
                    "id": SupportTicketQueryEngine.DEDUPLICATION_LOCK_ID,
                    "expiresAtMilliseconds": { "$lt": now_milliseconds },
                },
                {
                    "$set":
                    {
                        "id": SupportTicketQueryEngine.DEDUPLICATION_LOCK_ID,
                        "ownerToken": owner_token,
                        "acquiredAtMilliseconds": now_milliseconds,
                        "expiresAtMilliseconds": expires_at_milliseconds,
                        # A real BSON date for the TTL index, which is only a
                        # backstop against a crashed worker — the workflow releases
                        # the lease itself in a finally block.
                        "expiresAt": datetime.datetime.utcfromtimestamp(expires_at_milliseconds / 1000),
                    }
                },
                upsert=True
            )

            if result.matched_count > 0 or result.upserted_id is not None:
                return owner_token

            return None
        except Exception as lock_error:
            # A duplicate-key error means another worker upserted first.
            print(f"[SupportTicketQueryEngine] Could not acquire the deduplication lock: {lock_error}")
            return None

    @staticmethod
    async def release_deduplication_lock(owner_token: str) -> None:
        """
        Releases the lease, but only if this worker still owns it — a lease that
        already expired and was taken by someone else must not be cleared here.
        """
        if not owner_token:
            return

        collection = (await DatabaseConnector.get_database())[DatabaseConstants.SUPPORT_TICKET_DEDUPLICATION_LOCKS_COLLECTION]
        collection.update_one(
            { "id": SupportTicketQueryEngine.DEDUPLICATION_LOCK_ID, "ownerToken": owner_token },
            { "$set": { "expiresAtMilliseconds": 0 } }
        )
