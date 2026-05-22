from typing import Any, List
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
