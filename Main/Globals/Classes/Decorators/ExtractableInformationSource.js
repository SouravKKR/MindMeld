import InformationSource from '../../Model/InformationSource.js';
import PageRange from './PageRange.js';

class ExtractableInformationSource
{
    #informationSource;
    #pageRanges;

    constructor({informationSource = null, pageRanges = []} = {})
    {
        this.setInformationSource(informationSource);
        this.setPageRanges(pageRanges);
    }

    getInformationSource()
    {
        return this.#informationSource;
    }

    setInformationSource(value)
    {
        this.#informationSource = value;
    }

    getPageRanges()
    {
        return this.#pageRanges;
    }

    setPageRanges(value)
    {
        if (value !== null)
        {
            if (!Array.isArray(value))
            {
                value = null;
            }
        }
        this.#pageRanges = value;
    }

    toJson()
    {
        return {
            informationSource: this.getInformationSource() !== null ? this.getInformationSource().toJson() : null,
            pageRanges: this.getPageRanges() !== null ? this.getPageRanges().map(item => item.toJson()) : null,
        };
    }

    static fromJson(json)
    {
        const instance = new ExtractableInformationSource({
            informationSource: json.informationSource != null ? InformationSource.fromJson(json.informationSource) : null,
            pageRanges: json.pageRanges != null ? json.pageRanges.map(item => PageRange.fromJson(item)) : null
        });
        return instance;
    }
}

export default ExtractableInformationSource;
