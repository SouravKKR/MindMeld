import re
import fitz
from sentence_transformers import SentenceTransformer


CHUNK_SIZE        = 150
CHUNK_OVERLAP     = 20
NOMIC_TASK_PREFIX = "search_document: "
ENCODE_BATCH_SIZE = 32
EMBEDDING_MODEL   = "nomic-ai/nomic-embed-text-v1"


def _clean_text(text: str) -> str:
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    text = re.sub(r"-\s+", "", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"[\u2022\u2023\u25aa\u25cf\u2013\u2014\u2015\u2018\u2019\u201c\u201d]", " ", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _chunk_text(text: str) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        end = start + CHUNK_SIZE
        chunks.append(" ".join(words[start:end]))
        start = end - CHUNK_OVERLAP
    return chunks


def load_model() -> SentenceTransformer:
    print(f"Loading embedding model: {EMBEDDING_MODEL}")
    model = SentenceTransformer(EMBEDDING_MODEL, trust_remote_code=True, device="cpu")
    print("Model loaded.")
    return model


def embed_pages(pdf_bytes: bytes, page_numbers: list[int], model: SentenceTransformer) -> tuple[list[dict], list[int]]:
    """
    Extracts, cleans, chunks and embeds the given page numbers from a PDF.

    Returns:
        embedding_documents : list of { pageNumber, content, embedding }
        empty_pages         : list of page numbers that had no extractable text
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    all_chunks      = []
    all_page_labels = []
    empty_pages     = []

    for page_number in page_numbers:
        raw_text = doc[page_number - 1].get_text("text").strip()

        if not raw_text:
            empty_pages.append(page_number)
            continue

        clean = _clean_text(raw_text)

        if not clean:
            empty_pages.append(page_number)
            continue

        chunks = _chunk_text(clean)
        all_chunks.extend(chunks)
        all_page_labels.extend([page_number] * len(chunks))

    doc.close()

    if not all_chunks:
        return [], empty_pages

    print(f"Embedding {len(all_chunks)} chunk(s) across {len(page_numbers) - len(empty_pages)} page(s)...")

    prefixed   = [NOMIC_TASK_PREFIX + chunk for chunk in all_chunks]
    embeddings = model.encode(
        prefixed,
        batch_size=ENCODE_BATCH_SIZE,
        convert_to_numpy=True,
        show_progress_bar=True
    )

    embedding_documents = [
        {
            "pageNumber": page_number,
            "content":    chunk,
            "embedding":  embedding.tolist(),
        }
        for page_number, chunk, embedding in zip(all_page_labels, all_chunks, embeddings)
    ]

    return embedding_documents, empty_pages