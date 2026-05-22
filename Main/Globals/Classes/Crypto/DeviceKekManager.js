/**
 * DeviceKekManager
 *
 * Maintains a per-device key-encryption-key (KEK) used to unwrap the
 * per-deck content keys delivered by the server inside a DeckLicense.
 * The KEK never leaves the browser as raw bytes — it is stored in
 * IndexedDB as a non-extractable CryptoKey, which means JS code (even
 * the dev console) cannot read it back into a plain ArrayBuffer.
 *
 * NOTE on the threat model: a determined attacker with full JS-debugger
 * access can still call cryptoKey.unwrapKey on attacker-supplied input.
 * The non-extractable flag prevents *exfiltration* of the raw key, not
 * its use within the page. This raises the bar significantly (it stops
 * `cryptoKey.exportKey('raw')` and casual console reads) without
 * pretending to be a hardware-backed enclave.
 */
class DeviceKekManager
{
    static #DB_NAME = "MindMeldCrypto";
    static #STORE_NAME = "deviceKeks";
    static #RECORD_ID = "primary";

    static #cachedKekPromise = null;

    static async #openDatabase()
    {
        return await new Promise((resolve, reject) =>
        {
            const openRequest = indexedDB.open(DeviceKekManager.#DB_NAME, 1);

            openRequest.onupgradeneeded = () =>
            {
                const database = openRequest.result;
                if (!database.objectStoreNames.contains(DeviceKekManager.#STORE_NAME))
                {
                    database.createObjectStore(DeviceKekManager.#STORE_NAME);
                }
            };

            openRequest.onsuccess = () => resolve(openRequest.result);
            openRequest.onerror = () => reject(openRequest.error);
        });
    }

    static async #readStoredKey()
    {
        const database = await DeviceKekManager.#openDatabase();
        return await new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(DeviceKekManager.#STORE_NAME, "readonly");
            const store = transaction.objectStore(DeviceKekManager.#STORE_NAME);
            const getRequest = store.get(DeviceKekManager.#RECORD_ID);

            getRequest.onsuccess = () => resolve(getRequest.result || null);
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    static async #writeStoredKey(cryptoKey)
    {
        const database = await DeviceKekManager.#openDatabase();
        await new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(DeviceKekManager.#STORE_NAME, "readwrite");
            const store = transaction.objectStore(DeviceKekManager.#STORE_NAME);
            const putRequest = store.put(cryptoKey, DeviceKekManager.#RECORD_ID);

            putRequest.onsuccess = () => resolve();
            putRequest.onerror = () => reject(putRequest.error);
        });
    }

    static async getOrCreateKek()
    {
        if (DeviceKekManager.#cachedKekPromise)
        {
            return await DeviceKekManager.#cachedKekPromise;
        }

        DeviceKekManager.#cachedKekPromise = (async () =>
        {
            const existing = await DeviceKekManager.#readStoredKey();

            if (existing instanceof CryptoKey)
            {
                return existing;
            }

            const newKek = await crypto.subtle.generateKey
            (
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
            );

            await DeviceKekManager.#writeStoredKey(newKek);
            return newKek;
        })();

        return await DeviceKekManager.#cachedKekPromise;
    }

    static async computePublicFingerprint()
    {
        // The KEK itself is non-extractable, so we derive a stable
        // public-facing fingerprint by encrypting a known constant under
        // it. The fingerprint never reveals the key but it stays the
        // same across reloads, so the server can correlate one device's
        // multiple sessions.
        const kek = await DeviceKekManager.getOrCreateKek();
        const constantPlaintext = new TextEncoder().encode("MindMeld:DeviceFingerprint:v1");
        const initializationVector = new Uint8Array(12);

        const ciphertext = await crypto.subtle.encrypt
        (
            { name: "AES-GCM", iv: initializationVector },
            kek,
            constantPlaintext
        );

        const ciphertextBytes = new Uint8Array(ciphertext);
        const hexCharacters = [];
        for (const byte of ciphertextBytes)
        {
            hexCharacters.push(byte.toString(16).padStart(2, "0"));
        }
        return hexCharacters.join("").slice(0, 64);
    }
}

export default DeviceKekManager;
