// Collects the inline images embedded in the retrieved cards / study materials
// for a chat turn, DEDUPLICATES them (the same figure often appears on several
// cards), caps count + total size to respect the AskAi attachment limits, and
// assigns each a stable reference id.
//
// The deduped images are sent to the model as vision input (so it can reason
// over them), and the model is told it may embed a relevant one back into its
// answer as <img data-deck-image-id="N"> — a tiny reference, never base64. The
// chat renderer then swaps that reference for the real image from idToDataUrl,
// so a relevant deck image "shows up" inline without round-tripping base64
// through the LLM.

class DeckImageHarvester
{
    static DEFAULT_MAX_IMAGES = 4;
    static DEFAULT_MAX_TOTAL_BYTES = 7 * 1024 * 1024;   // ~7 MB, under AskAi's cap
    static DEFAULT_MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // skip a single huge image

    /**
     * Returns { attachedImages: [{ mimeType, base64Data, id }], idToDataUrl: Map }.
     * idToDataUrl maps the reference id (string) to the full `data:` URL for
     * inline rendering. Order of preference follows the order entities are passed
     * in (most-relevant first), so the budget keeps the most relevant images.
     */
    static harvest(cards, materials, options = {})
    {
        const maxImages = options.maxImages || DeckImageHarvester.DEFAULT_MAX_IMAGES;
        const maxTotalBytes = options.maxTotalBytes || DeckImageHarvester.DEFAULT_MAX_TOTAL_BYTES;
        const maxImageBytes = options.maxImageBytes || DeckImageHarvester.DEFAULT_MAX_IMAGE_BYTES;

        const htmlFragments = [];
        for (const card of cards || [])
        {
            htmlFragments.push(card.getQuestion());
            htmlFragments.push(card.getAnswer());
        }
        for (const material of materials || [])
        {
            htmlFragments.push(material.getContent());
        }

        const attachedImages = [];
        const idToDataUrl = new Map();
        const seenContentHashes = new Set();
        let totalBytes = 0;
        let nextId = 1;

        for (const htmlFragment of htmlFragments)
        {
            for (const dataUrl of DeckImageHarvester.#extractDataUrls(htmlFragment))
            {
                if (attachedImages.length >= maxImages)
                {
                    return { attachedImages, idToDataUrl };
                }

                const parsed = DeckImageHarvester.#parseDataUrl(dataUrl);
                if (parsed === null)
                {
                    continue;
                }

                const contentHash = DeckImageHarvester.#hashString(parsed.base64Data);
                if (seenContentHashes.has(contentHash))
                {
                    continue;
                }

                const approximateBytes = Math.floor(parsed.base64Data.length * 0.75);
                if (approximateBytes > maxImageBytes || totalBytes + approximateBytes > maxTotalBytes)
                {
                    continue;
                }

                seenContentHashes.add(contentHash);
                totalBytes += approximateBytes;

                const id = String(nextId++);
                attachedImages.push({ mimeType: parsed.mimeType, base64Data: parsed.base64Data, id });
                idToDataUrl.set(id, dataUrl);
            }
        }

        return { attachedImages, idToDataUrl };
    }

    static #extractDataUrls(html)
    {
        if (typeof html !== "string" || html.length === 0)
        {
            return [];
        }

        const urls = [];
        const pattern = /<img[^>]+src\s*=\s*["'](data:image\/[^"']+)["']/gi;
        let match = pattern.exec(html);
        while (match !== null)
        {
            urls.push(match[1]);
            match = pattern.exec(html);
        }
        return urls;
    }

    static #parseDataUrl(dataUrl)
    {
        const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
        if (match === null)
        {
            return null;
        }
        return { mimeType: match[1], base64Data: match[2] };
    }

    static #hashString(value)
    {
        let hash = 0x811c9dc5;
        // Sample long base64 strings (every 7th char) — enough to dedup identical
        // images cheaply without hashing megabytes character by character.
        const step = value.length > 4096 ? 7 : 1;
        for (let characterIndex = 0; characterIndex < value.length; characterIndex += step)
        {
            hash ^= value.charCodeAt(characterIndex);
            hash = Math.imul(hash, 0x01000193);
        }
        return `${value.length}:${(hash >>> 0).toString(16)}`;
    }
}

export default DeckImageHarvester;
