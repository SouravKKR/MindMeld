import DialogBox from "../../CommonComponents/DialogBox.js";
import Card from "../../Globals/Model/Card.js";
import Deck from "../../Globals/Model/Deck.js";
import Lifecycle from "../../Globals/Model/Lifecycle.js";
import Progress from "../../Globals/Model/Progress.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import { scaleDownImage } from "../../Globals/UtilityFunctions/ScaleDownImage.js";
import RichTextEditor from "./Components/RichTextEditor.js";
import ActiveEntityTracker from "../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import CardEvents from "../../Globals/Events/CardEvents.js";

class CardEditorPage extends HTMLElement
{
    #originalValues = {};
    #card = null;
    #bNewCard = false;

    initialize(card, deck)
    {
        this.#card = card;

        if(!this.#card)
        {
            this.#card = new Card(Card.generateId(), "", "", [], deck.getId(), Card.getDefaultBaseDifficulty(), new Progress(), new Lifecycle(), {});
            this.#bNewCard = true;
        }

        this.#originalValues = 
        {
            question: this.#card.getQuestion(),
            answer: this.#card.getAnswer(),
            tags: this.#card.getTags(),
            progress: this.#card.getProgress(),
            deckId: this.#card.getDeckId(),
            additionalData: this.#card.getAdditionalData()
        };


    }

    #setupInputs()
    {
        const deckSelector = this.querySelector(".deck-select");
        const questionEditor = this.querySelector(".question-editor");
        const answerEditor = this.querySelector(".answer-editor");
        const tagsInput = this.querySelector(".tags-input");
        const reviewCheckbox = this.querySelector(".review-checkbox");

        const filter = (deck) => 
        { 
            return deck != Deck.getRoot(); 
        };

        Deck.configureSearchableSelector(deckSelector, filter, Deck.getRoot(), this.#card.getDeckId(), "Select deck...");

        if(!this.#bNewCard)
        {
            questionEditor.setInnerHtml(this.#card.getQuestion());
            answerEditor.setInnerHtml(this.#card.getAnswer());
            tagsInput.value = this.#card.getTags().join(",");
            reviewCheckbox.checked = this.#card.isReview();
        }

    }

    #handleEvents()
    {
        const questionEditor = this.querySelector(".question-editor");
        const answerEditor = this.querySelector(".answer-editor");
        const tagsInput = this.querySelector(".tags-input");

        const resetProgressButton = this.querySelector(".reset-progress-button");
        const deleteCardButton = this.querySelector(".delete-card-button");
        const cancelButton = this.querySelector(".cancel-button");
        const saveButton = this.querySelector(".save-button");
        const reviewCheckbox = this.querySelector(".review-checkbox");

        resetProgressButton.addEventListener("click", () => 
        {
            this.#card.setProgress(new Progress());
        });

        deleteCardButton.addEventListener("click", async () =>
        {
            const result = await DialogBox.confirm("Delete Card?", "Are you sure you want to delete this card?");

            if(result)
            {
                await this.#card.delete();
                PageNavigator.back();
            }
        });

        cancelButton.addEventListener("click", async () =>
        {
            const result = await DialogBox.confirm("Discard Changes?", "Are you sure you want to discard changes?");
            
            if(result)
            {
                this.#card.setQuestion(this.#originalValues.question);
                this.#card.setAnswer(this.#originalValues.answer);
                this.#card.setTags(this.#originalValues.tags);
                this.#card.setProgress(this.#originalValues.progress);
                this.#card.setAdditionalData(this.#originalValues.additionalData);

                PageNavigator.back();
            }
        });

        saveButton.addEventListener("click", async () => 
        {
            this.#card.setQuestion(questionEditor.getInnerHtml());
            this.#card.setAnswer(answerEditor.getInnerHtml());
            this.#card.setTags(tagsInput.value.split(","));
            this.#card.setAdditionalDataField("review", (reviewCheckbox.checked ? true : false));

            if(!this.#card.validate(true))
            {
                return;
            }

            // Tag cards created while the tutorial is running so they can be
            // cleared via "Start over" or the Finish-time cleanup option.
            if (this.#bNewCard && TutorialEngine.isRunning())
            {
                this.#card.setAdditionalDataField(TutorialEngine.CREATED_DURING_TUTORIAL_KEY, true);
            }

            if(!this.#card.getDeck().hasCard(this.#card))
            {

                if(this.#bNewCard)
                {
                    this.#card.getDeck().addCard(this.#card);
                }
                else
                {
                    this.#card.move(Deck.getById(this.#originalValues.deckId), this.#card.getDeck());
                }

            }

            // Snapshot before initialize() resets bNewCard for the
            // post-save "create another" flow.
            const bWasEditingExistingCard = !this.#bNewCard;

            await this.#card.save();

            // Dispatched here (post-validate + post-save) so listeners like
            // the tutorial engine can advance only on a real successful save,
            // not on validation-rejected clicks.
            window.dispatchEvent(new CustomEvent(CardEvents.SAVE, { detail: { card: this.#card } }));

            // When the editor was opened to edit an existing card (e.g.
            // from the Study page's Edit affordance), saving should
            // return the user to wherever they came from — staying on a
            // fresh blank card is jarring mid-study session. Brand-new
            // card creation keeps the "stay open for the next card"
            // flow below, which is useful from the deck-editor "Add
            // card" path.
            if (bWasEditingExistingCard)
            {
                PageNavigator.back();
                return;
            }

            this.initialize(null, this.#card.getDeck());
            ActiveEntityTracker.set(this.#card.getId(), entityTypes.CARD);

            // Reset all input elements
            this.querySelectorAll("rich-text-editor").forEach(editor => editor.clear());
            this.querySelectorAll("input").forEach(input =>
            {
                if(input.type == "text")
                {
                    input.value = "";
                }

                if(input.type == "checkbox")
                {
                    input.checked = false;
                }
            });

            this.#setupInputs();

            // TODO: Decide if you need this
            // const editNewCard = await DialogBox.confirm("Edit Another Card?", "Would you like to continue making/editing cards?");

            // if(!editNewCard)
            // {
            //     PageNavigator.back();
            // }

        });

        const onPaste = (pasteEvent) =>
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
        };

        questionEditor.addEventListener("paste", onPaste);
        answerEditor.addEventListener("paste", onPaste);
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="Edit Card"></header-component>
            <div class="card-editor">
                <button type="button" class="deck-select"></button>
                <rich-text-editor class="question-editor" placeholder="Enter Question Here..."></rich-text-editor>
                <rich-text-editor class="answer-editor" placeholder="Enter Answer Here..."></rich-text-editor>
                <input type="text" class="tags-input" value="${this.#card.getTags().join(",")}" placeholder="Enter Tags (Comma Separated)..." class="tags-input">
                <div class="field-container review-checkbox-container">
                    <label for="review-checkbox">Mark for Review: </label>
                    <input type="checkbox" class="review-checkbox">
                </div>
            </div>
            <div class="card-editor-button-container reset-delete-container">
                <button class="reset-progress-button">Reset Progress</button>
                <button class="delete-card-button">Delete Card</button>
            </div>
            <div class="card-editor-button-container save-cancel-container">
                <button class="cancel-button">Cancel</button>
                <button class="save-button">Save</button>
            </div>

        `;

        this.#setupInputs();
        this.#handleEvents();

        ActiveEntityTracker.set(this.#card.getId(), entityTypes.CARD);
    }

    onPageResumed()
    {
        if (this.#card)
        {
            ActiveEntityTracker.set(this.#card.getId(), entityTypes.CARD);
        }
    }
}

customElements.define("card-editor-page", CardEditorPage);
export default CardEditorPage;