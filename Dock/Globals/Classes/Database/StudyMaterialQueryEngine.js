const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

class StudyMaterialQueryEngine
{
    static #PROJECTION = { projection: { _id: 0 } };

    static async getStudyMaterialsModifiedSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);

        return await collection.find(
        {
            userId,
            "data.lifecycle.lastModified": { $gt: sinceDate }
        }, StudyMaterialQueryEngine.#PROJECTION).toArray();
    }

    static async getDeletionsSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);

        const deletions = await collection.find(
        {
            userId,
            entityType: "study_material",
            deletedAt: { $gt: sinceDate }
        }, { projection: { _id: 0, entityId: 1 } }).toArray();

        return deletions.map(d => d.entityId);
    }

    static async upsertStudyMaterial(studyMaterialDocument)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);

        const existing = await collection.findOne({ id: studyMaterialDocument.id });
        const incomingLastModified = new Date(studyMaterialDocument.lifecycle.lastModified);

        if (existing && new Date(existing.lifecycle.lastModified) > incomingLastModified)
        {
            return;
        }

        const normalized =
        {
            ...studyMaterialDocument,
            lifecycle:
            {
                ...studyMaterialDocument.lifecycle,
                creationDate: new Date(studyMaterialDocument.lifecycle.creationDate),
                lastModified: new Date(studyMaterialDocument.lifecycle.lastModified),
            }
        };

        await collection.updateOne(
            { id: normalized.id },
            { $set: normalized },
            { upsert: true }
        );
    }

    static async deleteStudyMaterialIfNotModified(id, userId, clientLastSyncedAt)
    {
        const db = await DatabaseConnector.getDatabase();
        const collection = db.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
        const deletionsCollection = db.collection(DatabaseConstants.DELETIONS_COLLECTION);

        const existing = await collection.findOne({ id });

        if (!existing) return false;

        const sinceDate = clientLastSyncedAt instanceof Date ? clientLastSyncedAt : new Date(clientLastSyncedAt);

        if (new Date(existing.lifecycle.lastModified) > sinceDate)
        {
            return false;
        }

        await collection.deleteOne({ id });

        await deletionsCollection.insertOne(
        {
            userId,
            entityId: id,
            entityType: "study_material",
            deletedAt: new Date()
        });

        return true;
    }
}

module.exports = StudyMaterialQueryEngine;