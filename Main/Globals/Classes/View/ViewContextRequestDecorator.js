import UserIdentityManager from "../UserIdentityManager.js";

/**
 * ViewContextRequestDecorator
 *
 * Tells the server which library a request belongs to, by stamping the active
 * view onto every same-origin request as a header.
 *
 * This is installed as a `window.fetch` wrapper rather than threaded through
 * each call site, and that is a deliberate choice rather than a shortcut. The
 * view is a property of the whole SESSION, not of any one endpoint: the moment a
 * single request forgot the header it would read or write the wrong library, and
 * the failure would be silent — a member's work saved into their personal decks,
 * an organization's content pulled into them, or a sandbox's decks merged into a
 * real library. Making it impossible to forget is worth more here than the
 * explicitness of a per-call parameter.
 *
 * ONE wrapper for both kinds of view, and one header per request. This class
 * replaced an organization-only decorator rather than sitting beside it: a
 * second wrapper would mean two `Request` rebuilds and two same-origin URL
 * parses on every call, plus an ordering dependency between two module tags in
 * index.html. And emitting at most one header is deliberate — the identity is
 * already mutually exclusive, so a request carrying both would force the server
 * to invent a precedence rule the client had already decided.
 *
 * The header is a CLAIM, never an authorisation. Dock re-checks it on every
 * request (ViewScopeResolver — membership for an organization, the administrator
 * role for a plan view) and falls back to the personal scope when it does not
 * hold, so a forged value buys nothing.
 *
 * Cross-origin requests are left untouched — the view means nothing to a third
 * party, and adding a custom header would force a CORS preflight on requests
 * that presently need none.
 */
class ViewContextRequestDecorator
{
    static ORGANIZATION_HEADER_NAME = "X-Organization-Context";
    static PLAN_VIEW_HEADER_NAME = "X-Plan-View";

    static #bInstalled = false;

    /**
     * Wraps window.fetch. Idempotent — a second call is a no-op, so a module
     * that imports this twice cannot end up with two layers of wrapper.
     */
    static install()
    {
        if (ViewContextRequestDecorator.#bInstalled || typeof window === "undefined" || typeof window.fetch !== "function")
        {
            return;
        }

        const originalFetch = window.fetch.bind(window);
        ViewContextRequestDecorator.#bInstalled = true;

        window.fetch = function fetchWithViewContext(resource, options)
        {
            const activeViewHeader = ViewContextRequestDecorator.#readActiveViewHeader();

            if (activeViewHeader === null || !ViewContextRequestDecorator.#isSameOrigin(resource))
            {
                return originalFetch(resource, options);
            }

            // A Request object carries its own headers, so it has to be rebuilt
            // rather than have an options bag layered over it — Request wins over
            // init for everything it already defines.
            if (typeof Request !== "undefined" && resource instanceof Request)
            {
                const decoratedRequest = new Request(resource);
                decoratedRequest.headers.set(activeViewHeader.name, activeViewHeader.value);
                return originalFetch(decoratedRequest, options);
            }

            const decoratedOptions = { ...(options || {}) };
            const headers = new Headers(decoratedOptions.headers || {});
            headers.set(activeViewHeader.name, activeViewHeader.value);
            decoratedOptions.headers = headers;

            return originalFetch(resource, decoratedOptions);
        };
    }

    /**
     * The single header this request should carry, or null in the personal view.
     */
    static #readActiveViewHeader()
    {
        try
        {
            const organizationContextId = UserIdentityManager.getOrganizationContextId();

            if (organizationContextId.length > 0)
            {
                return { name: ViewContextRequestDecorator.ORGANIZATION_HEADER_NAME, value: organizationContextId };
            }

            const planViewTierName = UserIdentityManager.getPlanViewTierName();

            if (planViewTierName.length > 0)
            {
                return { name: ViewContextRequestDecorator.PLAN_VIEW_HEADER_NAME, value: planViewTierName };
            }
        }
        catch (error)
        {
            // Never let a view lookup break a request. Personal is the safe
            // direction in both cases: the worst outcome is a user seeing their
            // own library, never someone else's and never a simulation they did
            // not ask for.
            console.warn("[ViewContextRequestDecorator] Could not read the active view:", error);
        }

        return null;
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

ViewContextRequestDecorator.install();

export default ViewContextRequestDecorator;
