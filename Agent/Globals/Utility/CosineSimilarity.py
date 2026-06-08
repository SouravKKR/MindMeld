import numpy as np


def cosine_similarity(vector_a, vector_b) -> float:
    """
    Returns the cosine similarity in [-1.0, 1.0] between two equal-length
    numeric vectors. Returns 0.0 for any degenerate input — empty vector,
    zero-norm vector, mismatched lengths, or non-iterable input — so callers
    can use the result directly as a similarity score without guarding.
    """
    if vector_a is None or vector_b is None:
        return 0.0

    array_a = np.asarray(vector_a, dtype = np.float64).ravel()
    array_b = np.asarray(vector_b, dtype = np.float64).ravel()

    if array_a.size == 0 or array_b.size == 0 or array_a.size != array_b.size:
        return 0.0

    norm_a = np.linalg.norm(array_a)
    norm_b = np.linalg.norm(array_b)

    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0

    return float(np.dot(array_a, array_b) / (norm_a * norm_b))
