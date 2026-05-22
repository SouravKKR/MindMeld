class PageRange
{
    #startPage;
    #endPage;

    constructor({startPage = 0, endPage = 0} = {})
    {
        this.setStartPage(startPage);
        this.setEndPage(endPage);
    }

    getStartPage()
    {
        return this.#startPage;
    }

    setStartPage(value)
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
        this.#startPage = value;
    }

    getEndPage()
    {
        return this.#endPage;
    }

    setEndPage(value)
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
        this.#endPage = value;
    }

    toJson()
    {
        return {
            startPage: this.getStartPage(),
            endPage: this.getEndPage(),
        };
    }

    static fromJson(json)
    {
        const instance = new PageRange({
            startPage: json.startPage ?? null,
            endPage: json.endPage ?? null
        });
        return instance;
    }
}

export default PageRange;
