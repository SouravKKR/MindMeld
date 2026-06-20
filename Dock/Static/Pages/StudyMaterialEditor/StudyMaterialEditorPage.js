import DialogBox from "../../CommonComponents/DialogBox.js";
import StudyMaterial from "../../Globals/Model/StudyMaterial.js";
import Deck from "../../Globals/Model/Deck.js";
import Lifecycle from "../../Globals/Model/Lifecycle.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import { scaleDownImage } from "../../Globals/UtilityFunctions/ScaleDownImage.js";
import RichTextEditor from "../CardEditor/Components/RichTextEditor.js";
import ActiveEntityTracker from "../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";

/**
 * StudyMaterialEditorPage
 *
 * Mirrors the structure of CardEditorPage so the two editors behave
 * the same way from the learner's perspective:
 *
 *   - Single `<rich-text-editor>` per editable field. Raw-HTML editing
 *     lives inside the rich-text-editor's own toolbar (Code icon), not
 *     as a page-level tab. There used to be a page-level Rich Text /
 *     Raw HTML tab pair here; it became redundant once the rich-text
 *     editor grew its own per-instance toggle (which is also what the
 *     card editor uses), so it was removed.
 *   - Save returns to the previous page when editing an existing
 *     entity (e.g. opened from the Study page's Edit affordance) and
 *     resets for the next entry when creating a new one — same rule
 *     CardEditorPage applies. Keeps mid-study edits from dumping the
 *     learner on a blank editor.
 */
class StudyMaterialEditorPage extends HTMLElement
{
    #studyMaterial = null;
    #bNewStudyMaterial = false;
    #originalContent = "";
    #originalDeckId = "";

    initialize(studyMaterial, deck)
    {
        this.#studyMaterial = studyMaterial;

        if (!this.#studyMaterial)
        {
            this.#studyMaterial = new StudyMaterial(
                StudyMaterial.generateId(),
                "",
                deck.getId(),
                new Lifecycle()
            );
            this.#bNewStudyMaterial = true;
        }

        this.#originalContent = this.#studyMaterial.getContent();
        this.#originalDeckId = this.#studyMaterial.getDeckId();
    }

    #setupInputs()
    {
        const deckSelector = this.querySelector(".deck-select");

        Deck.configureSearchableSelector(
            deckSelector,
            (deck) => deck !== Deck.getRoot(),
            Deck.getRoot(),
            this.#studyMaterial.getDeckId(),
            "Select deck..."
        );

        if (!this.#bNewStudyMaterial)
        {
            this.querySelector(".content-editor").setInnerHtml(this.#studyMaterial.getContent());
        }
    }

    #handleEvents()
    {
        const deckSelector = this.querySelector(".deck-select");
        const contentEditor = this.querySelector(".content-editor");
        const cancelButton = this.querySelector(".cancel-button");
        const saveButton = this.querySelector(".save-button");
        const deleteButton = this.querySelector(".delete-study-material-button");

        cancelButton.addEventListener("click", async () =>
        {
            const result = await DialogBox.confirm("Discard Changes?", "Are you sure you want to discard changes?");

            if (result)
            {
                this.#studyMaterial.setContent(this.#originalContent);
                PageNavigator.back();
            }
        });

        saveButton.addEventListener("click", async () =>
        {
            const content = contentEditor.getInnerHtml();
            const selectedDeckId = deckSelector.value;

            this.#studyMaterial.setContent(content);

            if (!this.#studyMaterial.validate(true))
            {
                return;
            }

            const selectedDeck = Deck.getById(selectedDeckId);

            if (this.#bNewStudyMaterial)
            {
                this.#studyMaterial.setDeckId(selectedDeckId);
                selectedDeck.addStudyMaterial(this.#studyMaterial);
            }
            else if (selectedDeckId !== this.#originalDeckId)
            {
                const originalDeck = Deck.getById(this.#originalDeckId);
                originalDeck?.removeStudyMaterial(this.#studyMaterial);
                this.#studyMaterial.setDeckId(selectedDeckId);
                selectedDeck.addStudyMaterial(this.#studyMaterial);
            }

            // Snapshot before initialize() flips bNewStudyMaterial for
            // the post-save "create another" flow.
            const bWasEditingExisting = !this.#bNewStudyMaterial;

            await this.#studyMaterial.save();

            // Mid-study edits land here via the Study page's Edit
            // affordance; bouncing the user to a fresh blank editor
            // mid-session is jarring. Brand-new material creation keeps
            // the "stay open for the next entry" flow below — useful
            // when batch-authoring lessons from the deck editor.
            if (bWasEditingExisting)
            {
                PageNavigator.back();
                return;
            }

            this.initialize(null, this.#studyMaterial.getDeck());
            ActiveEntityTracker.set(this.#studyMaterial.getId(), entityTypes.STUDY_MATERIAL, true);

            this.querySelectorAll("rich-text-editor").forEach((editor) => editor.clear());

            this.#setupInputs();
        });

        deleteButton.addEventListener("click", async () =>
        {
            const result = await DialogBox.confirm("Delete Study Material?", "Are you sure you want to delete this study material?");

            if (result)
            {
                await this.#studyMaterial.delete();
                PageNavigator.back();
            }
        });

        contentEditor.addEventListener("paste", (pasteEvent) =>
        {
            const items = pasteEvent.clipboardData.items;
            const selection = window.getSelection();

            if (!selection.rangeCount)
            {
                return;
            }

            const range = selection.getRangeAt(0);

            for (let i = 0; i < items.length; i++)
            {
                if (items[i].type.indexOf("image") !== -1)
                {
                    pasteEvent.preventDefault();

                    const file = items[i].getAsFile();
                    const reader = new FileReader();

                    reader.onload = (event) =>
                    {
                        scaleDownImage(event.target.result, 0.7, (compressedImage) =>
                        {
                            const img = document.createElement("img");
                            img.src = compressedImage;
                            img.style.maxWidth = "100%";

                            range.deleteContents();
                            range.insertNode(img);
                            range.setStartAfter(img);
                            range.setEndAfter(img);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        });
                    };

                    reader.readAsDataURL(file);
                }
            }
        });
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="Edit Study Material"></header-component>
            <div class="study-material-editor">
                <button type="button" class="deck-select"></button>
                <rich-text-editor class="content-editor" placeholder="Enter study material content..."></rich-text-editor>
            </div>
            <div class="study-material-editor-button-container delete-container">
                <button class="delete-study-material-button">Delete Study Material</button>
            </div>
            <div class="study-material-editor-button-container save-cancel-container">
                <button class="cancel-button">Cancel</button>
                <button class="save-button">Save</button>
            </div>
        `;

        this.#setupInputs();
        this.#handleEvents();

        ActiveEntityTracker.set(this.#studyMaterial.getId(), entityTypes.STUDY_MATERIAL, true);
    }

    onPageResumed()
    {
        if (this.#studyMaterial)
        {
            ActiveEntityTracker.set(this.#studyMaterial.getId(), entityTypes.STUDY_MATERIAL, true);
        }
    }
}

customElements.define("study-material-editor-page", StudyMaterialEditorPage);
export default StudyMaterialEditorPage;
