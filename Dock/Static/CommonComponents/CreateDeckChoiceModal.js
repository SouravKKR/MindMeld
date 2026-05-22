import DialogBox from "./DialogBox.js";
import { deckCreationOptions } from "../Globals/Enumerations/DeckCreationOptions.js";

/**
 * CreateDeckChoiceModal
 *
 * Three-option chooser shown when a logged-in, online user clicks the
 * + tile on the home page. Lets them start a brand-new deck, open the
 * paid-deck marketplace, or import a deck from a .emmd file. Resolves
 * to a `deckCreationOptions` enum value (CREATE_NEW_DECK,
 * BROWSE_PAID_LIBRARY, or IMPORT_FROM_FILE) or null when the user
 * dismisses the dialog.
 *
 * Offline / logged-out callers bypass this modal entirely and go
 * straight to the existing deck-editor flow.
 */
class CreateDeckChoiceModal
{
    static #DATA_CHOICE_ATTRIBUTE = "data-choice";

    static show()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(CreateDeckChoiceModal.#getMarkup());

            const closeButton = dialog.querySelector(".close-button");
            const optionButtons = dialog.querySelectorAll(".create-deck-choice-option");

            let bResolved = false;

            const finalize = (choice) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(choice);
            };

            for (const optionButton of optionButtons)
            {
                optionButton.addEventListener("click", () =>
                {
                    const rawValue = optionButton.getAttribute(CreateDeckChoiceModal.#DATA_CHOICE_ATTRIBUTE);
                    const parsedChoice = Number(rawValue);

                    if (!Object.values(deckCreationOptions).includes(parsedChoice))
                    {
                        finalize(null);
                        return;
                    }

                    finalize(parsedChoice);
                });
            }

            if (closeButton)
            {
                closeButton.addEventListener("click", () => finalize(null));
            }
        });
    }

    static #getMarkup()
    {
        return `
            <div class="create-deck-choice">
                <h2 class="create-deck-choice-title">What would you like to do?</h2>
                <p class="create-deck-choice-subtitle">Build your own from scratch, import an existing deck, or grab a ready-made deck from the library.</p>
                <div class="create-deck-choice-buttons">
                    <button class="create-deck-choice-option create-deck-choice-create" data-choice="${deckCreationOptions.CREATE_NEW_DECK}">
                        <span class="create-deck-choice-option-icon">＋</span>
                        <span class="create-deck-choice-option-body">
                            <span class="create-deck-choice-option-title">Create a new deck</span>
                            <span class="create-deck-choice-option-description">Start blank and add your own cards</span>
                        </span>
                    </button>
                    <button class="create-deck-choice-option create-deck-choice-import" data-choice="${deckCreationOptions.IMPORT_FROM_FILE}">
                        <span class="create-deck-choice-option-icon">📂</span>
                        <span class="create-deck-choice-option-body">
                            <span class="create-deck-choice-option-title">Import from file</span>
                            <span class="create-deck-choice-option-description">Load a .emmd deck exported from MindMeld</span>
                        </span>
                    </button>
                    <button class="create-deck-choice-option create-deck-choice-buy" data-choice="${deckCreationOptions.BROWSE_PAID_LIBRARY}">
                        <span class="create-deck-choice-option-icon">🛍️</span>
                        <span class="create-deck-choice-option-body">
                            <span class="create-deck-choice-option-title">Browse paid decks</span>
                            <span class="create-deck-choice-option-description">Curated decks ready to study, instantly</span>
                        </span>
                    </button>
                </div>
            </div>
        `;
    }
}

export default CreateDeckChoiceModal;
