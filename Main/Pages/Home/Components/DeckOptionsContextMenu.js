import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import HomePageContextMenu from "./HomePageContextMenu.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";


class DeckOptionsContextMenu extends ContextMenu
{
    #deck = null;

    static tagName = "deck-options-context-menu";

    initialize(position = { x: 0, y: 0 }, deck)
    {
        super.initialize(position);
        this.#deck = deck;
    }

    #openEntityPicker(title, options)
    {
        const buttons = options.map(opt =>
            `<button class="entity-picker-button">${opt.label}</button>`
        ).join("");

        const dialog = DialogBox.modal(
            `<div class="entity-picker">
                <h2 style="margin: 0 0 16px 0; font-size: 1.1em;">${title}</h2>
                ${buttons}
            </div>`
        );

        dialog.querySelectorAll(".entity-picker-button").forEach((btn, i) =>
        {
            btn.addEventListener("click", () =>
            {
                dialog.close();
                options[i].handler();
            });
        });
    }

    #handleEvents()
    {
        const insightsButton       = this.querySelector(".insights-button");
        const addButton            = this.querySelector(".add-button");
        const expandButton         = this.querySelector(".expand-button");
        const editButton           = this.querySelector(".edit-button");
        const browseButton         = this.querySelector(".browse-button");
        const exportButton         = this.querySelector(".export-button");
        const generateWithAIButton = this.querySelector(".generate-with-ai-button");

        this.addEventListener("click", (event) => { event.stopPropagation(); });

        insightsButton.addEventListener("click", () =>
        {
            PageNavigator.open("deck-insights-page", this.#deck);
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.removeAll();
        });

        addButton.addEventListener("click", () =>
        {
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.removeAll();

            this.#openEntityPicker("Add to deck", [
                {
                    label:   "Card",
                    handler: () => PageNavigator.open("card-editor-page", null, this.#deck)
                },
                {
                    label:   "Study Material",
                    handler: () => PageNavigator.open("study-material-editor-page", null, this.#deck)
                },
                {
                    label:   "Mock Test",
                    handler: () => PageNavigator.open("mock-test-editor-page", null, this.#deck)
                },
            ]);
        });

        expandButton.addEventListener("click", () =>
        {
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: this.#deck } }));
        });

        generateWithAIButton.addEventListener("click", async () =>
        {
            if(!window["user"])
            {
                await DialogBox.alert("Error", "You must be logged in to use this feature.");
                return;
            }

            if (!await AiFeatureGate.ensureAdminOrShowAlert())
            {
                return;
            }

            PageNavigator.open("automatic-generation-page", this.#deck);
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.removeAll();
        });

        editButton.addEventListener("click", () =>
        {
            PageNavigator.open("deck-editor-page", this.#deck, this.#deck.getParent());
            DeckOptionsContextMenu.removeAll();
        });

        browseButton.addEventListener("click", () =>
        {
            DeckOptionsContextMenu.removeAll();
            HomePageContextMenu.removeAll();

            this.#openEntityPicker("Browse", [
                {
                    label:   "Cards",
                    handler: () => PageNavigator.open("browser-page", this.#deck, entityTypes.CARD)
                },
                {
                    label:   "Study Materials",
                    handler: () => PageNavigator.open("browser-page", this.#deck, entityTypes.STUDY_MATERIAL)
                },
                {
                    label:   "Mock Tests",
                    handler: () => PageNavigator.open("browser-page", this.#deck, entityTypes.MOCK_TEST)
                },
            ]);
        });

        exportButton.addEventListener("click", () =>
        {
            const dialog = DialogBox.modal(
                `
                    <style>
                        .export-options-body
                        {
                            display: flex;
                            flex-direction: column;
                            gap: 6px;
                            padding: 4px 14px 14px 14px;
                            min-width: min(360px, 88vw);
                        }
                        .export-options-body .export-options-title
                        {
                            margin: 6px 0 4px 0;
                            font-size: 1.15rem;
                            font-weight: 700;
                            text-align: center;
                        }
                        .export-options-body .export-ipr-disclaimer
                        {
                            margin: 0 0 6px 0;
                            padding: 8px 10px;
                            border-radius: 6px;
                            border: 1px solid rgba(220, 150, 60, 0.5);
                            background-color: rgba(220, 150, 60, 0.08);
                            font-size: 12px;
                            line-height: 1.4;
                        }
                        .export-options-body .export-ipr-disclaimer strong
                        {
                            color: rgb(230, 170, 80);
                        }
                        .export-options-body .export-field-container
                        {
                            padding: 6px 4px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                            font-size: 14px;
                        }
                        .export-options-body .export-field-container label
                        {
                            flex: 1;
                            cursor: pointer;
                        }
                        .export-options-body .export-field-container input[type="checkbox"]
                        {
                            width: 18px;
                            height: 18px;
                            flex-shrink: 0;
                            cursor: pointer;
                        }
                        .export-options-body .export-button-container
                        {
                            margin-top: 8px;
                        }
                        .export-options-body .export-button
                        {
                            background-color: var(--accent-color, #1a73e8);
                            color: #fff;
                            font-weight: 600;
                            padding: 10px;
                            border-radius: 6px;
                            width: 100%;
                            border: none;
                            cursor: pointer;
                            font-size: 14px;
                        }
                        @media (orientation: portrait), (max-width: 600px)
                        {
                            .export-options-body
                            {
                                padding: 2px 10px 10px 10px;
                                gap: 4px;
                                min-width: 0;
                            }
                            .export-options-body .export-options-title
                            {
                                font-size: 1.05rem;
                                margin: 4px 0 2px 0;
                            }
                            .export-options-body .export-ipr-disclaimer
                            {
                                font-size: 11.5px;
                                padding: 7px 9px;
                            }
                            .export-options-body .export-field-container
                            {
                                padding: 5px 2px;
                                font-size: 13.5px;
                                gap: 8px;
                            }
                        }
                    </style>
                    <div class="export-options-body">
                        <div class="export-options-title">Export Options</div>
                        <div class="export-ipr-disclaimer">
                            <strong>You are responsible for any third-party content in this deck.</strong>
                            By exporting and sharing it, you confirm you have the rights to do so. MindMeld does not verify ownership of exported material.
                        </div>
                        <div class="export-field-container">
                            <label for="retain-progress-checkbox">Retain Progress</label>
                            <input id="retain-progress-checkbox" type="checkbox" class="retain-progress-checkbox" checked>
                        </div>
                        <div class="export-field-container">
                            <label for="recursive-checkbox">Recursive</label>
                            <input id="recursive-checkbox" type="checkbox" class="recursive-checkbox" checked>
                        </div>
                        <div class="export-field-container">
                            <label for="retain-auto-analysis-settings-checkbox">Retain Auto-Analysis Settings</label>
                            <input id="retain-auto-analysis-settings-checkbox" type="checkbox" class="retain-auto-analysis-settings-checkbox">
                        </div>
                        <div class="export-button-container">
                            <button class="export-button">Export</button>
                        </div>
                    </div>
                `
            );

            dialog.querySelector(".export-button").addEventListener("click", async () =>
            {
                const retainProgress = dialog.querySelector(".retain-progress-checkbox").checked;
                const recursive      = dialog.querySelector(".recursive-checkbox").checked;
                const retainAutoAnalysisSettings = dialog.querySelector(".retain-auto-analysis-settings-checkbox").checked;

                await this.#deck.export({
                    bRecursive: recursive,
                    bRetainProgress: retainProgress,
                    bRetainAutoAnalysisSettings: retainAutoAnalysisSettings,
                });

                dialog.close();
            });

            DeckOptionsContextMenu.removeAll();
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="insights-button">Insights</button>
            <button class="add-button">Add</button>
            <button class="generate-with-ai-button">Generate With AI</button>
            <button class="expand-button">Expand</button>
            <button class="edit-button">Edit</button>
            <button class="browse-button">Browse</button>
            <button class="export-button">Export</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define("deck-options-context-menu", DeckOptionsContextMenu);
export default DeckOptionsContextMenu;
