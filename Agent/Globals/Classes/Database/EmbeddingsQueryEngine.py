from typing import Any, List
import numpy
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Constants.DatabaseConstants import DatabaseConstants


class EmbeddingsQueryEngine:

    # Name of the Atlas Vector Search index on the textEmbeddings collection.
    # Created by Dock's DatabaseConnector (#setupCollections) — keep this literal
    # in sync with DatabaseConnector.TEXT_EMBEDDINGS_VECTOR_INDEX_NAME.
    VECTOR_INDEX_NAME = "textEmbeddingsVectorSearch"

    @staticmethod
    async def upsert_embeddings(extractable_information_source: ExtractableInformationSource, embedding_documents: list[dict[str, Any]], collection_name: str = None) -> None:
        """
        Upserts a list of embedding documents for a given information source into the database.
        Each document must contain: pageNumber, content, embedding.
        Matched on userId + informationSourceHash + pageNumber + content, so a document
        uploaded by two users produces two independent chunk sets rather than one shared one.
        """
        collection = (await DatabaseConnector.get_database())[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        information_source = extractable_information_source.get_information_source()
        hash = information_source.get_hash()
        user_id = information_source.get_user_id()

        for document in embedding_documents:
            owner_scoped_key = {
                "userId": user_id,
                "informationSourceHash": hash,
                "pageNumber": document["pageNumber"],
                "content": document["content"],
            }
            collection.update_one(
                owner_scoped_key,
                {
                    "$set":
                    {
                        **owner_scoped_key,
                        "embedding": document["embedding"],
                    }
                },
                upsert=True
            )

    @staticmethod
    async def upsert_empty_pages(extractable_information_source: ExtractableInformationSource, page_numbers: list[int], collection_name: str = None) -> None:
        """
        Inserts placeholder documents for pages that have no extractable text.
        These have no embedding field so they are excluded from vector search,
        but their presence prevents them from being flagged as ungenerated on future runs.
        """
        collection = (await DatabaseConnector.get_database())[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        information_source = extractable_information_source.get_information_source()
        hash = information_source.get_hash()
        user_id = information_source.get_user_id()

        for page_number in page_numbers:
            owner_scoped_key = {
                "userId": user_id,
                "informationSourceHash": hash,
                "pageNumber": page_number,
                "content": None,
            }
            collection.update_one(owner_scoped_key, {"$set": owner_scoped_key}, upsert=True)

    @staticmethod
    async def get_pages_without_embeddings(extractable_information_source: ExtractableInformationSource, candidate_pages: List[int], collection_name: str = None) -> list[int]:
        """
        Given a list of candidate 1-indexed page numbers (already expanded from page_ranges),
        returns the subset that have no record in the database yet — including empty page placeholders as already-handled.
        """
        if not candidate_pages:
            return []

        collection = (await DatabaseConnector.get_database())[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        information_source = extractable_information_source.get_information_source()

        results = collection.distinct(
            "pageNumber",
            {
                "userId": information_source.get_user_id(),
                "informationSourceHash": information_source.get_hash(),
                "pageNumber": { "$in": candidate_pages },
            }
        )

        pages_with_records = set(results)

        return sorted(set(candidate_pages) - pages_with_records)

    @staticmethod
    async def __filter_hashes_owned_by_user(owner_user_id: str, information_source_hashes: list[str]) -> list[str]:
        """
        Narrows a caller-supplied hash list to those the user actually owns an
        information-source row for.

        Chunks now carry their owner and the retrieval queries filter on it,
        so this is the second of three independent checks rather than the only
        one: Dock filters the caller's hashes before spawning this worker, this
        method re-derives the permitted set from informationSources, and the
        queries below scope on userId as well. A hash is a SHA-512 of the file
        rather than a secret — anyone holding the same document can compute it —
        so none of the three is load-bearing alone.
        """
        if not owner_user_id or not information_source_hashes:
            return []

        database = await DatabaseConnector.get_database()
        information_sources_collection = database[DatabaseConstants.INFORMATION_SOURCES_COLLECTION]

        owned_documents = list(information_sources_collection.find(
            {
                "userId": owner_user_id,
                "hash": { "$in": information_source_hashes },
            },
            { "_id": 0, "hash": 1 }
        ))

        return list({ owned_document["hash"] for owned_document in owned_documents })

    @staticmethod
    async def vector_search(query_embedding: list[float], information_source_hashes: list[str], owner_user_id: str, top_k: int = 5, collection_name: str = None) -> list[dict[str, Any]]:
        """
        Cosine-similarity top-k retrieval scoped to a set of information
        source hashes THAT THE SUPPLIED USER OWNS. Used by the AskAi streaming
        worker to inline grounded excerpts into the LLM prompt.

        owner_user_id is mandatory: the supplied hashes originate from a client
        payload, so this method re-derives the permitted set from
        informationSources AND scopes the queries themselves on the owner.
        Passing an empty owner id returns no chunks rather than falling open.

        Runs as an Atlas $vectorSearch against the VECTOR_INDEX_NAME index
        (created by Dock's DatabaseConnector). If that index is missing or still
        building — or the deployment is a plain mongod with no search node — it
        transparently falls back to an in-memory brute-force cosine scan so
        grounding never silently disappears.

        Returns a list of { sourceName, pageNumber, content, similarity }
        objects, ordered by descending similarity. Empty list when no chunks are
        indexed for any of the permitted hashes.
        """
        if not information_source_hashes or not query_embedding:
            return []

        permitted_hashes = await EmbeddingsQueryEngine.__filter_hashes_owned_by_user(owner_user_id, information_source_hashes)

        withheld_count = len(set(information_source_hashes)) - len(permitted_hashes)
        if withheld_count > 0:
            print(f"[EmbeddingsQueryEngine] Withheld {withheld_count} source(s) not owned by user {owner_user_id}.")

        if not permitted_hashes:
            return []

        information_source_hashes = permitted_hashes

        top_k = max(0, int(top_k))
        if top_k == 0:
            return []

        database = await DatabaseConnector.get_database()
        embeddings_collection = database[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        try:
            scored_chunks = EmbeddingsQueryEngine.__atlas_vector_search(embeddings_collection, query_embedding, information_source_hashes, owner_user_id, top_k)
        except Exception as vector_search_error:
            print(f"[EmbeddingsQueryEngine] Atlas vector search unavailable, falling back to brute-force cosine: {vector_search_error}")
            scored_chunks = EmbeddingsQueryEngine.__brute_force_vector_search(embeddings_collection, query_embedding, information_source_hashes, owner_user_id, top_k)

        if not scored_chunks:
            return []

        # Batched lookup of source names so we don't issue one query per
        # chunk. The frontend has already de-duped the hash list.
        information_sources_collection = database[DatabaseConstants.INFORMATION_SOURCES_COLLECTION]
        source_documents = list(information_sources_collection.find(
            { "hash": { "$in": information_source_hashes } },
            { "_id": 0, "hash": 1, "name": 1 }
        ))
        hash_to_name = { source_document["hash"]: source_document.get("name", "Unnamed source") for source_document in source_documents }

        retrieved_chunks = []
        for scored_chunk in scored_chunks:
            retrieved_chunks.append(
            {
                "sourceName": hash_to_name.get(scored_chunk["informationSourceHash"], "Unnamed source"),
                "pageNumber": scored_chunk.get("pageNumber"),
                "content":    scored_chunk.get("content", ""),
                "similarity": scored_chunk.get("similarity"),
            })

        return retrieved_chunks

    @staticmethod
    def __atlas_vector_search(embeddings_collection, query_embedding: list[float], information_source_hashes: list[str], owner_user_id: str, top_k: int) -> list[dict[str, Any]]:
        """
        Approximate-nearest-neighbour retrieval via the Atlas $vectorSearch
        stage. numCandidates is over-fetched relative to top_k so the
        approximate search has enough breadth to surface the true top-k.
        Raises if the search index is not queryable (caller falls back).
        """
        pipeline = [
            {
                "$vectorSearch":
                {
                    "index": EmbeddingsQueryEngine.VECTOR_INDEX_NAME,
                    "path": "embedding",
                    "queryVector": [float(value) for value in query_embedding],
                    "numCandidates": max(top_k * 20, 150),
                    "limit": top_k,
                    "filter": { "userId": owner_user_id, "informationSourceHash": { "$in": information_source_hashes } },
                }
            },
            {
                "$project":
                {
                    "_id": 0,
                    "informationSourceHash": 1,
                    "pageNumber": 1,
                    "content": 1,
                    "similarity": { "$meta": "vectorSearchScore" },
                }
            },
        ]

        return list(embeddings_collection.aggregate(pipeline))

    @staticmethod
    def __brute_force_vector_search(embeddings_collection, query_embedding: list[float], information_source_hashes: list[str], owner_user_id: str, top_k: int) -> list[dict[str, Any]]:
        """
        Fallback path: pull every embedded chunk for the supplied hashes and
        score cosine similarity in-process. Linear in the number of candidate
        chunks; used only when the $vectorSearch index is unavailable.
        """
        candidate_documents = list(embeddings_collection.find(
            {
                "userId": owner_user_id,
                "informationSourceHash": { "$in": information_source_hashes },
                "embedding": { "$exists": True },
            },
            { "_id": 0, "informationSourceHash": 1, "pageNumber": 1, "content": 1, "embedding": 1 }
        ))

        if not candidate_documents:
            return []

        query_vector = numpy.asarray(query_embedding, dtype=numpy.float32)
        query_norm = numpy.linalg.norm(query_vector)
        if query_norm == 0.0:
            return []

        scored_chunks = []
        for candidate_document in candidate_documents:
            candidate_vector = numpy.asarray(candidate_document["embedding"], dtype=numpy.float32)
            candidate_norm = numpy.linalg.norm(candidate_vector)
            if candidate_norm == 0.0:
                continue
            similarity = float(numpy.dot(query_vector, candidate_vector) / (query_norm * candidate_norm))
            scored_chunks.append(
            {
                "informationSourceHash": candidate_document["informationSourceHash"],
                "pageNumber": candidate_document.get("pageNumber"),
                "content": candidate_document.get("content", ""),
                "similarity": similarity,
            })

        scored_chunks.sort(key=lambda entry: entry["similarity"], reverse=True)
        return scored_chunks[:top_k]
