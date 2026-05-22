class EncryptedDeckPayload
{
    #deckId;
    #keyVersion;
    #ivBase64;
    #ciphertextBase64;

    constructor({deckId = null, keyVersion = 1, ivBase64 = '', ciphertextBase64 = ''} = {})
    {
        this.setDeckId(deckId);
        this.setKeyVersion(keyVersion);
        this.setIvBase64(ivBase64);
        this.setCiphertextBase64(ciphertextBase64);
    }

    getDeckId()
    {
        return this.#deckId;
    }

    setDeckId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#deckId = value;
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

    getIvBase64()
    {
        return this.#ivBase64;
    }

    setIvBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#ivBase64 = value;
    }

    getCiphertextBase64()
    {
        return this.#ciphertextBase64;
    }

    setCiphertextBase64(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#ciphertextBase64 = value;
    }

    toJson()
    {
        return {
            deckId: this.getDeckId(),
            keyVersion: this.getKeyVersion(),
            ivBase64: this.getIvBase64(),
            ciphertextBase64: this.getCiphertextBase64(),
        };
    }

    static fromJson(json)
    {
        const instance = new EncryptedDeckPayload({
            deckId: json.deckId ?? null,
            keyVersion: json.keyVersion ?? null,
            ivBase64: json.ivBase64 ?? null,
            ciphertextBase64: json.ciphertextBase64 ?? null
        });
        return instance;
    }
}

module.exports = EncryptedDeckPayload;
