from typing import Any, List
import numpy
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Constants.DatabaseConstants import DatabaseConstants


class EmbeddingsQueryEngine:

    @staticmethod
    async def upsert_embeddings(extractable_information_source: ExtractableInformationSource, embedding_documents: list[dict[str, Any]], collection_name: str = None) -> None:
        """
        Upserts a list of embedding documents for a given information source into the database.
        Each document must contain: pageNumber, content, embedding.
        Matched on informationSourceHash + pageNumber + content to avoid duplicating chunks on re-runs.
        """
        collection = (await DatabaseConnector.get_database())[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        hash = extractable_information_source.get_information_source().get_hash()

        for document in embedding_documents:
            collection.update_one(
                {
                    "informationSourceHash": hash,
                    "pageNumber": document["pageNumber"],
                    "content": document["content"],
                },
                {
                    "$set":
                    {
                        "informationSourceHash": hash,
                        "pageNumber": document["pageNumber"],
                        "content": document["content"],
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

        hash = extractable_information_source.get_information_source().get_hash()

        for page_number in page_numbers:
            collection.update_one(
                {
                    "informationSourceHash": hash,
                    "pageNumber": page_number,
                    "content": None,
                },
                {
                    "$set":
                    {
                        "informationSourceHash": hash,
                        "pageNumber": page_number,
                        "content": None,
                    }
                },
                upsert=True
            )

    @staticmethod
    async def get_pages_without_embeddings(extractable_information_source: ExtractableInformationSource, candidate_pages: List[int], collection_name: str = None) -> list[int]:
        """
        Given a list of candidate 1-indexed page numbers (already expanded from page_ranges),
        returns the subset that have no record in the database yet — including empty page placeholders as already-handled.
        """
        if not candidate_pages:
            return []

        collection = (await DatabaseConnector.get_database())[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        hash = extractable_information_source.get_information_source().get_hash()

        results = collection.distinct(
            "pageNumber",
            {
                "informationSourceHash": hash,
                "pageNumber": { "$in": candidate_pages },
            }
        )

        pages_with_records = set(results)

        return sorted(set(candidate_pages) - pages_with_records)

    @staticmethod
    async def vector_search(query_embedding: list[float], information_source_hashes: list[str], top_k: int = 5, collection_name: str = None) -> list[dict[str, Any]]:
        """
        Cosine-similarity top-k retrieval scoped to a set of information
        source hashes. Used by the AskAi streaming worker to inline grounded
        excerpts into the LLM prompt.

        Returns a list of { sourceName, pageNumber, content } objects,
        ordered by descending similarity. Empty list when no chunks are
        indexed for any of the supplied hashes.
        """
        if not information_source_hashes or not query_embedding:
            return []

        database = await DatabaseConnector.get_database()
        embeddings_collection = database[collection_name or DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        candidate_documents = list(embeddings_collection.find(
            {
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
            scored_chunks.append((similarity, candidate_document))

        scored_chunks.sort(key=lambda entry: entry[0], reverse=True)
        top_scored = scored_chunks[:max(0, int(top_k))]

        # Batched lookup of source names so we don't issue one query per
        # chunk. The frontend has already de-duped the hash list.
        information_sources_collection = database[DatabaseConstants.INFORMATION_SOURCES_COLLECTION]
        source_documents = list(information_sources_collection.find(
            { "hash": { "$in": information_source_hashes } },
            { "_id": 0, "hash": 1, "name": 1 }
        ))
        hash_to_name = { source_document["hash"]: source_document.get("name", "Unnamed source") for source_document in source_documents }

        retrieved_chunks = []
        for similarity_score, candidate_document in top_scored:
            retrieved_chunks.append(
            {
                "sourceName": hash_to_name.get(candidate_document["informationSourceHash"], "Unnamed source"),
                "pageNumber": candidate_document.get("pageNumber"),
                "content":    candidate_document.get("content", ""),
                "similarity": similarity_score,
            })

        return retrieved_chunks
