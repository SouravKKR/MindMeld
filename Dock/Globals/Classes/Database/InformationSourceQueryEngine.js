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

    static async isLastInformationSourceWithSameContent(informationSource)
    {
        const collection = await (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION);
        const query = { hash: informationSource.getHash() };

        const informationSourceJson = await collection.find(query).limit(2).toArray();
        return informationSourceJson.length <= 1;
    }
    
}   

module.exports = InformationSourceQueryEngine;