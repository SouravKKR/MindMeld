/**
 * POST a JSON body to `path` with an AbortController-backed timeout.
 * Returns the parsed JSON on success, or null on:
 *   - non-OK HTTP status
 *   - network failure
 *   - the request being aborted because it exceeded `timeoutMilliseconds`
 *
 * Lifted out of SyncManager so the same helper can be reused by any other
 * client-side request that wants a hard timeout without an external dep.
 */
export async function fetchPostJsonWithTimeout(path, body, timeoutMilliseconds)
{
    const abortController = new AbortController();

    const timeoutId = setTimeout(() =>
    {
        abortController.abort();
    }, timeoutMilliseconds);

    try
    {
        const response = await fetch(path,
        {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
            signal:  abortController.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok)
        {
            console.error(`[fetchPostJsonWithTimeout] ${path} returned status ${response.status}`);
            return null;
        }

        return await response.json();
    }
    catch (error)
    {
        clearTimeout(timeoutId);

        if (error.name === "AbortError")
        {
            console.warn(`[fetchPostJsonWithTimeout] ${path} timed out after ${timeoutMilliseconds / 1000}s.`);
        }
        else
        {
            console.error(`[fetchPostJsonWithTimeout] ${path} failed:`, error);
        }

        return null;
    }
}

/**
 * GET the JSON at `path` with an AbortController-backed timeout. Same
 * failure semantics as `fetchPostJsonWithTimeout`. Used by the Force
 * Pull bulk-snapshot endpoint, which has no body and is conceptually
 * a read.
 */
export async function fetchGetJsonWithTimeout(path, timeoutMilliseconds)
{
    const abortController = new AbortController();

    const timeoutId = setTimeout(() =>
    {
        abortController.abort();
    }, timeoutMilliseconds);

    try
    {
        const response = await fetch(path,
        {
            method: "GET",
            signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok)
        {
            console.error(`[fetchGetJsonWithTimeout] ${path} returned status ${response.status}`);
            return null;
        }

        return await response.json();
    }
    catch (error)
    {
        clearTimeout(timeoutId);

        if (error.name === "AbortError")
        {
            console.warn(`[fetchGetJsonWithTimeout] ${path} timed out after ${timeoutMilliseconds / 1000}s.`);
        }
        else
        {
            console.error(`[fetchGetJsonWithTimeout] ${path} failed:`, error);
        }

        return null;
    }
}

export default fetchPostJsonWithTimeout;
