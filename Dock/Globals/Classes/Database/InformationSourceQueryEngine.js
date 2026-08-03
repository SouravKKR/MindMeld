const DatabaseConnector = require("./DatabaseConnector");
const InformationSource = require("../../Model/InformationSource");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

class InformationSourceQueryEngine
{
    /**
     * Saves an information source to the database.
     * @param {InformationSource} informationSource - The information source to save.
     * @return {Promise<void>} A promise that resolves when the information source is saved.
     */
    static async saveInformationSource(informationSource)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        await collection.updateOne({ id: informationSource.getId() }, { $set: informationSource.toJson() }, { upsert: true });
    }

    /**
     * Retrieves a single information source from the database by its id.
     * @param {string} id - The id of the information source to retrieve.
     * @return {Promise<InformationSource | null>} A promise that resolves to the information source if found, null otherwise.
     */
    static async getInformationSourceById(id)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const informationSourceJson = await collection.findOne({ id: id });
        return informationSourceJson ? InformationSource.fromJson(informationSourceJson) : null;
    }

    /**
     * Retrieves all information sources belonging to a given user.
     * @param {string} userId - The id of the user whose information sources to retrieve.
     * @return {Promise<InformationSource[]>} A promise that resolves to an array of information sources.
     */
    static async getInformationSourcesByUserId(userId)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const informationSourceJsonArray = await collection.find({ userId: userId }).toArray();
        return informationSourceJsonArray.map(informationSourceJson => InformationSource.fromJson(informationSourceJson));
    }

    /**
     * Checks whether a user has an information source record with the given hash.
     * Used to verify ownership in a CAS setup where multiple users can share the same file.
     * @param {string} userId - The id of the user to check.
     * @param {string} hash - The hash of the file to check.
     * @return {Promise<boolean>} A promise that resolves to true if the user owns a source with that hash, false otherwise.
     */
    static async doesUserOwnInformationSourceWithHash(userId, hash)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const informationSourceJson = await collection.findOne({ userId: userId, hash: hash });
        return informationSourceJson !== null;
    }

    /**
     * Checks whether a user already has an information source with the same content hash.
     * Used to prevent duplicate uploads by the same user.
     * @param {string} userId - The id of the user to check.
     * @param {string} hash - The hash of the file to check.
     * @return {Promise<boolean>} A promise that resolves to true if the user already has a source with that hash.
     */
    static async doesUserAlreadyHaveInformationSourceWithSameContent(userId, hash)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const informationSourceJson = await collection.findOne({ userId: userId, hash: hash });
        return informationSourceJson !== null;
    }

    /**
     * Narrows a caller-supplied list of content hashes down to the subset the
     * user actually owns a row for.
     *
     * This is the authorisation primitive behind grounded retrieval. The chunk
     * store is content-addressed and deliberately shared between every user who
     * uploaded the same bytes, so a chunk carries no tenant of its own — the
     * only place the tenant boundary exists is this hash-to-user mapping. Any
     * path that turns a client-supplied hash into document text must pass it
     * through here first.
     *
     * @param {string} userId - The authenticated user.
     * @param {string[]} candidateHashes - Hashes the caller asked for.
     * @return {Promise<string[]>} Only those hashes the user owns, de-duplicated.
     */
    static async filterHashesOwnedByUser(userId, candidateHashes)
    {
        if (typeof userId !== "string" || userId.length === 0 || !Array.isArray(candidateHashes))
        {
            return [];
        }

        const uniqueCandidateHashes = [...new Set(candidateHashes.filter(hash => typeof hash === "string" && hash.length > 0))];
        if (uniqueCandidateHashes.length === 0)
        {
            return [];
        }

        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const ownedDocuments = await collection.find(
            { userId: userId, hash: { $in: uniqueCandidateHashes } },
            { projection: { _id: 0, hash: 1 } },
        ).toArray();

        return [...new Set(ownedDocuments.map(ownedDocument => ownedDocument.hash))];
    }

    /**
     * Retrieves every information source row referencing a content hash, across
     * all tenants. Used by the admin takedown path, which must reach every user
     * the content-addressed store fanned the upload out to.
     * @param {string} hash - The sha512 content-addressed key.
     * @return {Promise<InformationSource[]>}
     */
    static async getInformationSourcesByHash(hash)
    {
        if (typeof hash !== "string" || hash.length === 0)
        {
            return [];
        }

        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const informationSourceJsonArray = await collection.find({ hash: hash }).toArray();
        return informationSourceJsonArray.map(informationSourceJson => InformationSource.fromJson(informationSourceJson));
    }

    /**
     * Lists user ids that currently own at least one information source.
     *
     * The retention reaper sweeps by account rather than by row, because whether
     * a document may be kept depends on the owner's subscription state, not on
     * anything stored on the row. Driving the sweep from distinct owners also
     * bounds the subscription lookups by user count instead of source count.
     *
     * @param {number} limit - Maximum owners to return in one sweep.
     * @return {Promise<string[]>}
     */
    static async getUserIdsWithSources(limit)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const userIds = await collection.distinct("userId");
        return userIds.filter(userId => typeof userId === "string" && userId.length > 0).slice(0, limit);
    }

    static async doesInformationSourceWithSameContentExist(informationSource)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const query = { hash: informationSource.getHash() };

        const informationSourceJson = await collection.findOne(query);
        return informationSourceJson ? true : false;
    }

    /**
     * Deletes an information source from the database.
     * @param {InformationSource} informationSource - The information source to delete.
     * @return {Promise<void>} A promise that resolves when the information source is deleted.
     */
    static async deleteInformationSource(informationSource)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        await collection.deleteOne({ id: informationSource.getId() });
    }

}   

module.exports = InformationSourceQueryEngine;