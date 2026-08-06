import UserIdentityManager from "../UserIdentityManager.js";

/**
 * OrganizationContextRequestDecorator
 *
 * Tells the server which library a request belongs to, by stamping the active
 * organization context onto every same-origin request as a header.
 *
 * This is installed as a `window.fetch` wrapper rather than threaded through
 * each call site, and that is a deliberate choice rather than a shortcut. The
 * context is a property of the whole VIEW, not of any one endpoint: the moment a
 * single request forgot the header it would read or write the wrong library, and
 * the failure would be silent — a member's work saved into their personal decks,
 * or an organization's content pulled into them. Making it impossible to forget
 * is worth more here than the explicitness of a per-call parameter.
 *
 * The header is a CLAIM, never an authorisation. Dock re-checks it against
 * stored membership on every request (OrganizationScopeResolver) and falls back
 * to the personal scope when it does not hold, so a forged value buys nothing.
 *
 * Cross-origin requests are left untouched — the context means nothing to a
 * third party, and adding a custom header would force a CORS preflight on
 * requests that presently need none.
 */
class OrganizationContextRequestDecorator
{
    static HEADER_NAME = "X-Organization-Context";

    static #bInstalled = false;

    /**
     * Wraps window.fetch. Idempotent — a second call is a no-op, so a module
     * that imports this twice cannot end up with two layers of wrapper.
     */
    static install()
    {
        if (OrganizationContextRequestDecorator.#bInstalled || typeof window === "undefined" || typeof window.fetch !== "function")
        {
            return;
        }

        const originalFetch = window.fetch.bind(window);
        OrganizationContextRequestDecorator.#bInstalled = true;

        window.fetch = function fetchWithOrganizationContext(resource, options)
        {
            const organizationContextId = OrganizationContextRequestDecorator.#readContextId();

            if (organizationContextId.length === 0 || !OrganizationContextRequestDecorator.#isSameOrigin(resource))
            {
                return originalFetch(resource, options);
            }

            // A Request object carries its own headers, so it has to be rebuilt
            // rather than have an options bag layered over it — Request wins over
            // init for everything it already defines.
            if (typeof Request !== "undefined" && resource instanceof Request)
            {
                const decoratedRequest = new Request(resource);
                decoratedRequest.headers.set(OrganizationContextRequestDecorator.HEADER_NAME, organizationContextId);
                return originalFetch(decoratedRequest, options);
            }

            const decoratedOptions = { ...(options || {}) };
            const headers = new Headers(decoratedOptions.headers || {});
            headers.set(OrganizationContextRequestDecorator.HEADER_NAME, organizationContextId);
            decoratedOptions.headers = headers;

            return originalFetch(resource, decoratedOptions);
        };
    }

    static #readContextId()
    {
        try
        {
            return UserIdentityManager.getOrganizationContextId();
        }
        catch (error)
        {
            // Never let a context lookup break a request. Falling back to the
            // personal view is the safe direction: the worst case is a member
            // seeing their own library, not an organization's leaking out.
            console.warn("[OrganizationContextRequestDecorator] Could not read the active context:", error);
            return "";
        }
    }

    static #isSameOrigin(resource)
    {
        try
        {
            const url = (typeof Request !== "undefined" && resource instanceof Request)
                ? resource.url
                : String(resource);

            // Relative urls — which is every internal call in this app — resolve
            // against the page, so they are same-origin by construction.
            return new URL(url, window.location.href).origin === window.location.origin;
        }
        catch (error)
        {
            return false;
        }
    }
}

OrganizationContextRequestDecorator.install();

export default OrganizationContextRequestDecorator;
