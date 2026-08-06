/**
 * AdvertisementLoader
 *
 * Loads Google AdSense at runtime, for the home page only, and never while a
 * checkout is open.
 *
 * ── Why this class exists ─────────────────────────────────────────────────
 *
 * The AdSense tag used to sit in index.html. In a multi-page site that would be
 * unremarkable; in this single-page application it meant the advertising script
 * was resident in the same document as the Razorpay checkout, with full DOM
 * access to it. That is the shape of a card-skimming attack, and it is what the
 * Razorpay handbook's B5 control and PCI DSS 6.4.3 exist to prevent — the
 * requirement is not "keep third-party scripts trustworthy" but "keep them off
 * the payment page".
 *
 * Moving the tag out of the document head buys three real things:
 *
 *   1. A cold entry into any payment surface — a paid-deck deep link, the
 *      credits dialog reached from a fresh load, the login page — never loads
 *      the ad script at all.
 *   2. The set of origins with script access to a payment page shrinks from
 *      "AdSense plus everything AdSense pulls in at runtime"
 *      (googletagservices, doubleclick, adtrafficquality) to the Razorpay
 *      widget alone.
 *   3. The strict Content-Security-Policy candidate becomes reachable, because
 *      the advertising origins are no longer needed on every page.
 *
 * ── The honest limit ──────────────────────────────────────────────────────
 *
 * Once injected, a script cannot be un-injected. If a user browses the home
 * page and then opens a checkout without a page reload, AdSense is still
 * resident in that document. Nothing short of a full navigation boundary can
 * change that, and forcing a reload on the way into checkout would be a worse
 * trade than the risk it removes.
 *
 * So this class does what is actually achievable: it never loads on a page that
 * is not the home page, and it refuses to load while a payment flow is open —
 * which closes the case that matters most, a buyer who lands directly on a
 * purchase surface. The residual case is documented rather than hidden, in
 * Common/ReadmeFiles/PaymentPageScriptInventory.md.
 */
class AdvertisementLoader
{
    static #ADSENSE_SOURCE = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5117647314462332";

    // Marks the injected tag so a second call can find it rather than adding
    // another, and so the inventory document has something to point at.
    static SCRIPT_ELEMENT_ID = "cogniumlearn-advertising-script";

    static #bHasRequestedLoad = false;

    // Raised for the whole duration of a checkout. A counter rather than a
    // boolean because two flows could overlap (a credits top-up opened from
    // inside a paid-deck purchase), and the first one to finish must not clear
    // a suppression the second still needs.
    static #openPaymentFlowCount = 0;

    /**
     * Whether a payment flow is currently open.
     * @returns {boolean}
     */
    static isPaymentFlowOpen()
    {
        return AdvertisementLoader.#openPaymentFlowCount > 0;
    }

    /**
     * Called when a checkout opens. While any flow is open no advertising
     * script may be injected.
     */
    static beginPaymentFlow()
    {
        AdvertisementLoader.#openPaymentFlowCount = AdvertisementLoader.#openPaymentFlowCount + 1;
    }

    /**
     * Called when a checkout closes, however it ended — paid, failed or
     * dismissed. Floored at zero so an unbalanced call can never leave the
     * counter negative and silently re-enable loading.
     */
    static endPaymentFlow()
    {
        AdvertisementLoader.#openPaymentFlowCount = Math.max(0, AdvertisementLoader.#openPaymentFlowCount - 1);
    }

    /**
     * Injects the advertising script, once, for the home page.
     *
     * Safe to call on every home-page mount: the first call injects and every
     * later one is a no-op. Callers other than the home page must not call it —
     * that restriction is the entire control, so it is asserted here rather
     * than trusted to convention.
     *
     * @param {string} pageTagName — the tag name of the page requesting the load
     * @returns {boolean} whether the script is now present
     */
    static loadForPage(pageTagName)
    {
        if (pageTagName !== "home-page")
        {
            return false;
        }

        if (AdvertisementLoader.isPaymentFlowOpen())
        {
            return false;
        }

        if (AdvertisementLoader.#bHasRequestedLoad)
        {
            return true;
        }

        AdvertisementLoader.#bHasRequestedLoad = true;

        const scriptElement = document.createElement("script");
        scriptElement.id = AdvertisementLoader.SCRIPT_ELEMENT_ID;
        scriptElement.async = true;
        scriptElement.crossOrigin = "anonymous";
        scriptElement.src = AdvertisementLoader.#ADSENSE_SOURCE;
        document.head.appendChild(scriptElement);

        return true;
    }
}

export default AdvertisementLoader;
