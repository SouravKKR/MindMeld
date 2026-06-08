import { deckPurchaseGranularity } from '../Enumerations/DeckPurchaseGranularity.js';
import { paidDeckFeatureBadges } from '../Enumerations/PaidDeckFeatureBadges.js';

class PaidDeck
{
    #id;
    #title;
    #description;
    #sellerId;
    #thumbnailUrl;
    #category;
    #tags;
    #basePriceMinor;
    #currency;
    #granularity;
    #bundleChildIds;
    #parentBundleIds;
    #assetBlobId;
    #keyVersion;
    #isPublished;
    #publishedAt;
    #featureBadges;
    #extraTags;
    #contentSummary;
    #additionalData;

    constructor({title = null, description = '', sellerId = '', thumbnailUrl = '', category = '', tags = [], basePriceMinor = 0, currency = 'INR', granularity = 0, bundleChildIds = [], parentBundleIds = [], assetBlobId = '', keyVersion = 1, isPublished = false, publishedAt = new Date(), featureBadges = [], extraTags = [], contentSummary = {}, additionalData = {}} = {})
    {
        this.#id = crypto.randomUUID();
        this.setTitle(title);
        this.setDescription(description);
        this.setSellerId(sellerId);
        this.setThumbnailUrl(thumbnailUrl);
        this.setCategory(category);
        this.setTags(tags);
        this.setBasePriceMinor(basePriceMinor);
        this.setCurrency(currency);
        this.setGranularity(granularity);
        this.setBundleChildIds(bundleChildIds);
        this.setParentBundleIds(parentBundleIds);
        this.setAssetBlobId(assetBlobId);
        this.setKeyVersion(keyVersion);
        this.setIsPublished(isPublished);
        this.setPublishedAt(publishedAt);
        this.setFeatureBadges(featureBadges);
        this.setExtraTags(extraTags);
        this.setContentSummary(contentSummary);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    getTitle()
    {
        return this.#title;
    }

    setTitle(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#title = value;
    }

    getDescription()
    {
        return this.#description;
    }

    setDescription(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 4096)
            {
                value = value.slice(0, 4096);
            }
        }
        this.#description = value;
    }

    getSellerId()
    {
        return this.#sellerId;
    }

    setSellerId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#sellerId = value;
    }

    getThumbnailUrl()
    {
        return this.#thumbnailUrl;
    }

    setThumbnailUrl(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 2048)
            {
                value = value.slice(0, 2048);
            }
        }
        this.#thumbnailUrl = value;
    }

    getCategory()
    {
        return this.#category;
    }

    setCategory(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 128)
            {
                value = value.slice(0, 128);
            }
        }
        this.#category = value;
    }

    getTags()
    {
        return this.#tags;
    }

    setTags(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#tags = value;
    }

    getBasePriceMinor()
    {
        return this.#basePriceMinor;
    }

    setBasePriceMinor(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 0;
            }
            else
            {
                value = Math.max(value, 0);
            }
        }
        this.#basePriceMinor = value;
    }

    getCurrency()
    {
        return this.#currency;
    }

    setCurrency(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 8)
            {
                value = value.slice(0, 8);
            }
        }
        this.#currency = value;
    }

    getGranularity()
    {
        return this.#granularity;
    }

    setGranularity(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(deckPurchaseGranularity);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#granularity = value;
    }

    getBundleChildIds()
    {
        return this.#bundleChildIds;
    }

    setBundleChildIds(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#bundleChildIds = value;
    }

    getParentBundleIds()
    {
        return this.#parentBundleIds;
    }

    setParentBundleIds(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#parentBundleIds = value;
    }

    getAssetBlobId()
    {
        return this.#assetBlobId;
    }

    setAssetBlobId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#assetBlobId = value;
    }

    getKeyVersion()
    {
        return this.#keyVersion;
    }

    setKeyVersion(value)
    {
        if (value !== null)
        {
            value = parseInt(value, 10);
            if (isNaN(value))
            {
                value = 1;
            }
            else
            {
                value = Math.max(value, 1);
            }
        }
        this.#keyVersion = value;
    }

    getIsPublished()
    {
        return this.#isPublished;
    }

    setIsPublished(value)
    {
        if (value !== null)
        {
            value = Boolean(value);
        }
        this.#isPublished = value;
    }

    getPublishedAt()
    {
        return this.#publishedAt;
    }

    setPublishedAt(value)
    {
        if (value !== null)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#publishedAt = value;
    }

    getFeatureBadges()
    {
        return this.#featureBadges;
    }

    setFeatureBadges(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#featureBadges = value;
    }

    getExtraTags()
    {
        return this.#extraTags;
    }

    setExtraTags(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#extraTags = value;
    }

    getContentSummary()
    {
        return this.#contentSummary;
    }

    setContentSummary(value)
    {
        this.#contentSummary = value;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    setAdditionalData(value)
    {
        this.#additionalData = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            title: this.getTitle(),
            description: this.getDescription(),
            sellerId: this.getSellerId(),
            thumbnailUrl: this.getThumbnailUrl(),
            category: this.getCategory(),
            tags: this.getTags(),
            basePriceMinor: this.getBasePriceMinor(),
            currency: this.getCurrency(),
            granularity: this.getGranularity() !== null ? Number(this.getGranularity()) : null,
            bundleChildIds: this.getBundleChildIds(),
            parentBundleIds: this.getParentBundleIds(),
            assetBlobId: this.getAssetBlobId(),
            keyVersion: this.getKeyVersion(),
            isPublished: this.getIsPublished(),
            publishedAt: this.getPublishedAt() !== null ? this.getPublishedAt().toISOString() : null,
            featureBadges: this.getFeatureBadges() !== null ? this.getFeatureBadges().map(item => Number(item)) : null,
            extraTags: this.getExtraTags(),
            contentSummary: this.getContentSummary(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new PaidDeck({
            title: json.title ?? null,
            description: json.description ?? null,
            sellerId: json.sellerId ?? null,
            thumbnailUrl: json.thumbnailUrl ?? null,
            category: json.category ?? null,
            tags: json.tags ?? null,
            basePriceMinor: json.basePriceMinor ?? null,
            currency: json.currency ?? null,
            granularity: json.granularity ?? null,
            bundleChildIds: json.bundleChildIds ?? null,
            parentBundleIds: json.parentBundleIds ?? null,
            assetBlobId: json.assetBlobId ?? null,
            keyVersion: json.keyVersion ?? null,
            isPublished: json.isPublished ?? null,
            publishedAt: json.publishedAt != null ? new Date(json.publishedAt) : null,
            featureBadges: json.featureBadges ?? null,
            extraTags: json.extraTags ?? null,
            contentSummary: json.contentSummary ?? null,
            additionalData: json.additionalData ?? null
        });
        instance._restoreId_id(json.id);
        return instance;
    }

    _restoreId_id(storedId)
    {
        if (storedId !== undefined && storedId !== null)
        {
            this.#id = storedId;
        }
    }
}

export default PaidDeck;
