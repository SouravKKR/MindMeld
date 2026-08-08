const Persistence = require("../Persistence");
const PersistenceConstants = require("../../Constants/PersistenceConstants");
const { joinPath } = require("../../UtilityFunctions.js/JoinPath");
const { informationSourceTypes } = require("../../Enumerations/InformationSourceTypes");
const GenerationProvenanceQueryEngine = require("../Database/GenerationProvenanceQueryEngine");
const PaidDeckGenerationGate = require("./PaidDeckGenerationGate");

/**
 * PaidDeckProvenanceAssembler
 *
 * Reads what the Agent wrote during a paid-deck run — the per-stage action-trail
 * files, the verification report, the coverage reconciliation — and folds them
 * into the single insert-only provenance document for the generated deck.
 *
 * Why assembly happens here rather than in the Agent. Agent stages run in
 * separate processes, some concurrently, and none of them knows the deck id:
 * decks are not created until MoveToDatabase runs. Dock is the first place where
 * "this run produced that deck" is a known fact, so it is where the trail is
 * bound to a deck and committed.
 *
 * Assembly is READ-ONLY over the run's own outputs and never re-derives
 * anything. It does not re-query models, re-check facts, or reconstruct what a
 * stage "must have" done — it reports what the stages recorded at the time, gaps
 * included. A record that reconstructs its own evidence is not evidence.
 */
class PaidDeckProvenanceAssembler
{
    /**
     * Assembles and records the provenance document for one completed run.
     *
     * Best-effort by design: a failure here must not undo a generated deck. The
     * cost of an assembly failure is a deck that cannot be published (the
     * publish gate refuses a deck with no provenance record), which is the
     * correct direction to fail in.
     *
     * @return {Promise<object|null>} The stored document, or null when nothing was recorded.
     */
    static async assembleAndRecord(assemblyDetails)
    {
        try
        {
            const actions = await PaidDeckProvenanceAssembler.#readActionTrail(assemblyDetails.mainTaskId);
            const verification = await PaidDeckProvenanceAssembler.#readJsonFile(
                assemblyDetails.mainTaskId,
                PersistenceConstants.PAID_DECK_VERIFICATION_FILE_NAME,
            );
            const coverageReconciliation = await PaidDeckProvenanceAssembler.#readJsonFile(
                assemblyDetails.mainTaskId,
                PersistenceConstants.COVERAGE_RECONCILIATION_FILE_NAME,
            );

            const sources = PaidDeckProvenanceAssembler.#extractSourceDeclarations(actions, assemblyDetails.generalGenerationSettings);

            return await GenerationProvenanceQueryEngine.record(
            {
                mainTaskId: assemblyDetails.mainTaskId,
                deckId: assemblyDetails.deckId,
                deckName: assemblyDetails.deckName,
                generatedByUserId: assemblyDetails.userId,
                producedDeckIds: assemblyDetails.producedDeckIds || [],
                sources: sources,
                declaredSourceTypeNames: sources.map(source => source.declaredSourceType).filter(Boolean),
                acceptedSourceTypeName: PaidDeckProvenanceAssembler.#resolveSourceTypeName(PaidDeckGenerationGate.ALLOWED_SOURCE_TYPE),
                actions: actions,
                verification: verification,
                coverageReconciliation: coverageReconciliation,
            });
        }
        catch (assemblyError)
        {
            console.error(`[PaidDeckProvenanceAssembler] Could not assemble provenance for run ${assemblyDetails.mainTaskId}: ${assemblyError.message}`);
            return null;
        }
    }

    /**
     * Reads every per-stage JSONL trail file and merges them into one
     * chronological list.
     *
     * Stages write separate files because they run in separate processes and
     * would otherwise overwrite each other. Merging by timestamp here restores
     * the single ordered trail the report needs. An unreadable or malformed line
     * is skipped with a warning rather than aborting — losing one line is
     * recoverable, losing the whole trail is not.
     */
    static async #readActionTrail(mainTaskId)
    {
        const actionLogPrefix = joinPath(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            mainTaskId,
            PersistenceConstants.PAID_DECK_ACTION_LOG_DIRECTORY,
        );

        let filePaths = [];
        try
        {
            filePaths = await Persistence.list(actionLogPrefix);
        }
        catch (listError)
        {
            console.warn(`[PaidDeckProvenanceAssembler] No action trail found at ${actionLogPrefix}: ${listError.message}`);
            return [];
        }

        const actions = [];

        for (const filePath of filePaths)
        {
            if (!filePath.endsWith(".jsonl"))
            {
                continue;
            }

            let fileContents = null;
            try
            {
                const fileBuffer = await Persistence.read(filePath);
                fileContents = fileBuffer.toString("utf8");
            }
            catch (readError)
            {
                console.warn(`[PaidDeckProvenanceAssembler] Could not read ${filePath}: ${readError.message}`);
                continue;
            }

            for (const line of fileContents.split("\n"))
            {
                const trimmedLine = line.trim();
                if (trimmedLine.length === 0)
                {
                    continue;
                }
                try
                {
                    actions.push(JSON.parse(trimmedLine));
                }
                catch (parseError)
                {
                    console.warn(`[PaidDeckProvenanceAssembler] Skipping unparseable trail line in ${filePath}.`);
                }
            }
        }

        actions.sort((firstAction, secondAction) =>
            (firstAction.timestampUtcMilliseconds || 0) - (secondAction.timestampUtcMilliseconds || 0));

        return actions;
    }

    static async #readJsonFile(mainTaskId, fileName)
    {
        const filePath = joinPath("/", PersistenceConstants.TASKS_DIRECTORY, mainTaskId, fileName);

        try
        {
            const fileBuffer = await Persistence.read(filePath);
            return JSON.parse(fileBuffer.toString("utf8"));
        }
        catch (readError)
        {
            console.warn(`[PaidDeckProvenanceAssembler] ${fileName} not available for run ${mainTaskId}: ${readError.message}`);
            return null;
        }
    }

    /**
     * Prefers the source declarations the Agent recorded at the time (they carry
     * the name and hash as the pipeline actually saw them). Falls back to the
     * run's settings when the trail is missing, so the report can still state
     * what was uploaded rather than showing nothing.
     */
    static #extractSourceDeclarations(actions, generalGenerationSettings)
    {
        const declaredSources = actions
            .filter(action => action.actionType === "SOURCE_DECLARATION")
            .map(action => (
            {
                name: action.sourceName || null,
                contentHash: action.contentHash || null,
                declaredSourceType: action.declaredSourceType || null,
            }));

        if (declaredSources.length > 0)
        {
            return declaredSources;
        }

        if (!generalGenerationSettings || typeof generalGenerationSettings.getInformationSources !== "function")
        {
            return [];
        }

        return (generalGenerationSettings.getInformationSources() || []).map((extractableSource) =>
        {
            const informationSource = extractableSource.getInformationSource();
            return {
                name: informationSource ? informationSource.getName() : null,
                contentHash: informationSource ? informationSource.getHash() : null,
                declaredSourceType: informationSource
                    ? PaidDeckProvenanceAssembler.#resolveSourceTypeName(informationSource.getSourceType())
                    : null,
            };
        });
    }

    static #resolveSourceTypeName(sourceTypeValue)
    {
        for (const [typeName, enumeratedValue] of Object.entries(informationSourceTypes))
        {
            if (enumeratedValue === sourceTypeValue)
            {
                return typeName;
            }
        }
        return null;
    }
}

module.exports = PaidDeckProvenanceAssembler;
