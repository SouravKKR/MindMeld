import DialogBox from "../../CommonComponents/DialogBox.js";
import StudyMaterial from "../../Globals/Model/StudyMaterial.js";
import Deck from "../../Globals/Model/Deck.js";
import Lifecycle from "../../Globals/Model/Lifecycle.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import { scaleDownImage } from "../../Globals/UtilityFunctions/ScaleDownImage.js";
import RichTextEditor from "../CardEditor/Components/RichTextEditor.js";
import ActiveEntityTracker from "../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";

class StudyMaterialEditorPage extends HTMLElement
{
    #studyMaterial = null;
    #bNewStudyMaterial = false;
    #originalContent = "";
    #originalDeckId = "";
    #bRawHtmlMode = false;

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

    #getActiveContent()
    {
        if (this.#bRawHtmlMode)
        {
            return this.querySelector(".raw-html-editor").value;
        }

        return this.querySelector(".content-editor").getInnerHtml();
    }

    #switchToRawHtml()
    {
        this.#bRawHtmlMode = true;

        const contentEditor = this.querySelector(".content-editor");
        const rawHtmlEditor = this.querySelector(".raw-html-editor");

        rawHtmlEditor.value = contentEditor.getInnerHtml();
        contentEditor.style.display = "none";
        rawHtmlEditor.style.display = "block";

        this.querySelector(".rich-text-tab").classList.remove("active-tab");
        this.querySelector(".raw-html-tab").classList.add("active-tab");
    }

    #switchToRichText()
    {
        this.#bRawHtmlMode = false;

        const contentEditor = this.querySelector(".content-editor");
        const rawHtmlEditor = this.querySelector(".raw-html-editor");

        contentEditor.setInnerHtml(rawHtmlEditor.value);
        rawHtmlEditor.style.display = "none";
        contentEditor.style.display = "";

        this.querySelector(".raw-html-tab").classList.remove("active-tab");
        this.querySelector(".rich-text-tab").classList.add("active-tab");
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

        this.querySelector(".raw-html-editor").style.display = "none";
    }

    #handleEvents()
    {
        const deckSelector = this.querySelector(".deck-select");
        const cancelButton = this.querySelector(".cancel-button");
        const saveButton = this.querySelector(".save-button");
        const deleteButton = this.querySelector(".delete-study-material-button");
        const richTextTab = this.querySelector(".rich-text-tab");
        const rawHtmlTab = this.querySelector(".raw-html-tab");
        const contentEditor = this.querySelector(".content-editor");

        richTextTab.addEventListener("click", () =>
        {
            if (this.#bRawHtmlMode)
            {
                this.#switchToRichText();
            }
        });

        rawHtmlTab.addEventListener("click", () =>
        {
            if (!this.#bRawHtmlMode)
            {
                this.#switchToRawHtml();
            }
        });

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
            const content = this.#getActiveContent();
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

            await this.#studyMaterial.save();
            PageNavigator.back();
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
                <div class="editor-mode-toggle">
                    <button class="editor-tab rich-text-tab active-tab">Rich Text</button>
                    <button class="editor-tab raw-html-tab">Raw HTML</button>
                </div>
                <rich-text-editor class="content-editor" placeholder="Enter study material content..."></rich-text-editor>
                <textarea class="raw-html-editor" placeholder="Enter raw HTML..."></textarea>
            </div>
            <div class="study-material-editor-button-container delete-container">
                <button class="delete-study-material-button">Delete</button>
            </div>
            <div class="study-material-editor-button-container save-cancel-container">
                <button class="cancel-button">Cancel</button>
                <button class="save-button">Save</button>
            </div>
        `;

        this.#setupInputs();
        this.#handleEvents();

        ActiveEntityTracker.set(this.#studyMaterial.getId(), entityTypes.STUDY_MATERIAL);
    }

    onPageResumed()
    {
        if (this.#studyMaterial)
        {
            ActiveEntityTracker.set(this.#studyMaterial.getId(), entityTypes.STUDY_MATERIAL);
        }
    }
}

customElements.define("study-material-editor-page", StudyMaterialEditorPage);
export default StudyMaterialEditorPage;
