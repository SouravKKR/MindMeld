/**
 * PaidDeckThumbnails
 *
 * Single source of truth for the built-in paid-deck thumbnail artwork
 * (the SVGs under Globals/Assets/Images/Icons/PaidDeckDefaultThumbnails)
 * plus the rule for resolving which image a given paid deck should show.
 *
 * The frontend can't enumerate a directory at runtime, so the filename
 * list is maintained here by hand — drop a file into the folder and add
 * a line to #FILE_NAMES and it appears in the picker.
 *
 * Consumed by:
 *   - PaidDeckThumbnailPicker (admin picker grid)
 *   - PaidDeckLibraryPage / PaidDeckDetailsPage (resolve what to render)
 */
class PaidDeckThumbnails
{
    static #BASE_PATH = "/Globals/Assets/Images/Icons/PaidDeckDefaultThumbnails/";

    // The generic fallback used when a deck carries neither an uploaded
    // image nor a chosen built-in thumbnail. Must be one of #FILE_NAMES.
    static #DEFAULT_FILE_NAME = "study-university-svgrepo-com.svg";

    static #FILE_NAMES =
    [
        "study-university-svgrepo-com.svg",
        "studying-underline-svgrepo-com.svg",
        "desk-svgrepo-com.svg",
        "math-book-svgrepo-com.svg",
        "calculator-svgrepo-com.svg",
        "law-book-law-svgrepo-com.svg",
        "flask-chemical-svgrepo-com.svg",
        "chemical-svgrepo-com.svg",
        "molecule-molecular-svgrepo-com.svg",
        "tech-color-desktop-svgrepo-com.svg",
        "tech-electronics-svgrepo-com.svg",
        "tech-ram-svgrepo-com.svg",
        "paint-art-svgrepo-com.svg",
        "canvas-svgrepo-com.svg",
        "puzzle-svgrepo-com.svg",
        "world-svgrepo-com.svg",
        "world-map-svgrepo-com.svg",
        "flats-skyscraper-svgrepo-com.svg",
        "rate-rating-survey-3-svgrepo-com.svg",
        "icon-for-s-that-can-be-used-in-business-part-3-svgrepo-com.svg",
        "basketball-svgrepo-com.svg",
        "ball-game-sport-svgrepo-com.svg",
        "badminton-svgrepo-com.svg",
        "trophy-svgrepo-com.svg",
        "fruit-morango-strawberries-svgrepo-com.svg",
        "fruit-limao-limon-svgrepo-com.svg",
        "watermelon-1-svgrepo-com.svg"
    ];

    /**
     * Builds the served URL for a built-in thumbnail. encodeURI keeps the
     * path separators intact while escaping the spaces / parentheses some
     * of the source filenames contain (e.g. "trophy-svgrepo-com (1).svg").
     */
    static #toUrl(fileName)
    {
        return encodeURI(PaidDeckThumbnails.#BASE_PATH + fileName);
    }

    /** Turns a filename into a friendly title for the picker tile caption. */
    static #toLabel(fileName)
    {
        return fileName
            .replace(/\.svg$/i, "")
            .replace(/-svgrepo-com.*$/i, "")
            .replace(/[-_]+/g, " ")
            .trim()
            .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    static getDefaultThumbnailUrl()
    {
        return PaidDeckThumbnails.#toUrl(PaidDeckThumbnails.#DEFAULT_FILE_NAME);
    }

    static getAllThumbnails()
    {
        return PaidDeckThumbnails.#FILE_NAMES.map((fileName) =>
        ({
            fileName: fileName,
            url: PaidDeckThumbnails.#toUrl(fileName),
            label: PaidDeckThumbnails.#toLabel(fileName)
        }));
    }

    /**
     * Picks the image a paid deck should render, in priority order:
     *   1. an admin-uploaded image stashed in additionalData.thumbnailImage
     *      (a self-contained data URL),
     *   2. an explicit thumbnailUrl (a chosen built-in or an external URL),
     *   3. the generic built-in fallback.
     * Operates on the plain storefront JSON the search endpoint returns.
     */
    static resolveDeckThumbnail(deck)
    {
        if (!deck || typeof deck !== "object")
        {
            return PaidDeckThumbnails.getDefaultThumbnailUrl();
        }

        const uploadedImage = (deck.additionalData && typeof deck.additionalData === "object")
            ? deck.additionalData.thumbnailImage
            : null;
        if (typeof uploadedImage === "string" && uploadedImage.trim().length > 0)
        {
            return uploadedImage;
        }

        if (typeof deck.thumbnailUrl === "string" && deck.thumbnailUrl.trim().length > 0)
        {
            return deck.thumbnailUrl;
        }

        return PaidDeckThumbnails.getDefaultThumbnailUrl();
    }
}

export default PaidDeckThumbnails;
