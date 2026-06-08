const { entityTypes } = require("../../Enumerations/EntityTypes");

/**
 * PaidDeckUserContentCloner
 *
 * Walks the decrypted master payload of a paid deck and produces the
 * shape stored in the paidDeckUserContent collection — a flat manifest
 * (one entry per deck / card / study material / mock test) plus a
 * contentByEntityId map keyed by entity ID. The clone is per-buyer:
 * once seeded, the buyer's edits mutate their own row only, leaving
 * the master untouched.
 *
 * Two supported input shapes (mirroring PaidDeckContentSummarizer):
 *   - Single tree: a Deck.toJson() with nested `subDecks`.
 *   - Export bundle: `{ metadata, data: [...decks flat with parent refs] }`.
 */
class PaidDeckUserContentCloner
{
    static clone(decryptedMasterPayload)
    {
        const rootDeckNode = PaidDeckUserContentCloner.#resolveRoot(decryptedMasterPayload);

        if (!rootDeckNode)
        {
            return {
                manifest: { rootDeckId: "", entries: [] },
                contentByEntityId: {}
            };
        }

        const manifestEntries = [];
        const contentByEntityId = {};

        PaidDeckUserContentCloner.#walk(rootDeckNode, 0, null, manifestEntries, contentByEntityId);

        return {
            manifest:
            {
                rootDeckId: typeof rootDeckNode.id === "string" ? rootDeckNode.id : "",
                entries: manifestEntries
            },
            contentByEntityId: contentByEntityId
        };
    }

    static #resolveRoot(decryptedMasterPayload)
    {
        if (!decryptedMasterPayload || typeof decryptedMasterPayload !== "object")
        {
            return null;
        }

        if (Array.isArray(decryptedMasterPayload.data))
        {
            return PaidDeckUserContentCloner.#reconstructTreeFromFlatList(decryptedMasterPayload.data);
        }

        return decryptedMasterPayload;
    }

    static #reconstructTreeFromFlatList(flatDeckList)
    {
        const decksById = new Map();
        for (const deckJson of flatDeckList)
        {
            if (deckJson && deckJson.id)
            {
                decksById.set(deckJson.id, { ...deckJson, subDecks: [] });
            }
        }

        let rootDeckNode = null;
        for (const deckJson of flatDeckList)
        {
            if (!deckJson || !deckJson.id)
            {
                continue;
            }
            const node = decksById.get(deckJson.id);
            const parentId = deckJson.parent;

            if (parentId && decksById.has(parentId))
            {
                decksById.get(parentId).subDecks.push(node);
            }
            else if (!rootDeckNode)
            {
                rootDeckNode = node;
            }
        }

        return rootDeckNode;
    }

    static #walk(deckNode, depth, parentDeckId, manifestEntries, contentByEntityId)
    {
        if (!deckNode || typeof deckNode !== "object" || typeof deckNode.id !== "string")
        {
            return;
        }

        const deckId = deckNode.id;
        const deckName = typeof deckNode.name === "string" ? deckNode.name : "Untitled deck";

        manifestEntries.push
        ({
            entityId: deckId,
            type: entityTypes.DECK,
            parentId: parentDeckId,
            name: deckName,
            depth: depth
        });

        const deckMetadataOnly = { ...deckNode };
        delete deckMetadataOnly.cards;
        delete deckMetadataOnly.studyMaterials;
        delete deckMetadataOnly.mockTests;
        delete deckMetadataOnly.subDecks;
        contentByEntityId[deckId] =
        {
            entityType: entityTypes.DECK,
            parentDeckId: parentDeckId,
            plaintext: deckMetadataOnly
        };

        const cards = Array.isArray(deckNode.cards) ? deckNode.cards : [];
        for (const cardJson of cards)
        {
            if (!cardJson || typeof cardJson.id !== "string")
            {
                continue;
            }
            const cardLabel = PaidDeckUserContentCloner.#extractCardLabel(cardJson);
            manifestEntries.push
            ({
                entityId: cardJson.id,
                type: entityTypes.CARD,
                parentId: deckId,
                name: cardLabel,
                depth: depth + 1
            });
            contentByEntityId[cardJson.id] =
            {
                entityType: entityTypes.CARD,
                parentDeckId: deckId,
                plaintext: cardJson
            };
        }

        const studyMaterials = Array.isArray(deckNode.studyMaterials) ? deckNode.studyMaterials : [];
        for (const studyMaterialJson of studyMaterials)
        {
            if (!studyMaterialJson || typeof studyMaterialJson.id !== "string")
            {
                continue;
            }
            const studyMaterialTitle = typeof studyMaterialJson.title === "string" ? studyMaterialJson.title : "Untitled study material";
            manifestEntries.push
            ({
                entityId: studyMaterialJson.id,
                type: entityTypes.STUDY_MATERIAL,
                parentId: deckId,
                name: studyMaterialTitle,
                depth: depth + 1
            });
            contentByEntityId[studyMaterialJson.id] =
            {
                entityType: entityTypes.STUDY_MATERIAL,
                parentDeckId: deckId,
                plaintext: studyMaterialJson
            };
        }

        const mockTests = Array.isArray(deckNode.mockTests) ? deckNode.mockTests : [];
        for (const mockTestJson of mockTests)
        {
            if (!mockTestJson || typeof mockTestJson.id !== "string")
            {
                continue;
            }
            const mockTestTitle = typeof mockTestJson.title === "string" ? mockTestJson.title : "Untitled mock test";
            manifestEntries.push
            ({
                entityId: mockTestJson.id,
                type: entityTypes.MOCK_TEST,
                parentId: deckId,
                name: mockTestTitle,
                depth: depth + 1
            });
            contentByEntityId[mockTestJson.id] =
            {
                entityType: entityTypes.MOCK_TEST,
                parentDeckId: deckId,
                plaintext: mockTestJson
            };
        }

        const subDecks = Array.isArray(deckNode.subDecks) ? deckNode.subDecks : [];
        for (const subDeckNode of subDecks)
        {
            if (subDeckNode && typeof subDeckNode === "object")
            {
                PaidDeckUserContentCloner.#walk(subDeckNode, depth + 1, deckId, manifestEntries, contentByEntityId);
            }
        }
    }

    static #extractCardLabel(cardJson)
    {
        const questionField = typeof cardJson.question === "string" ? cardJson.question : "";
        if (questionField.length === 0)
        {
            return "Untitled card";
        }
        // Manifest labels are short — strip HTML and cap at 80 chars so
        // the tree view stays readable.
        const stripped = questionField.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        return stripped.length > 80 ? `${stripped.slice(0, 77)}...` : stripped;
    }
}

module.exports = PaidDeckUserContentCloner;
