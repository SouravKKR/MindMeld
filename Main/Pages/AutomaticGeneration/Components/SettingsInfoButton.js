import DialogBox from "../../../CommonComponents/DialogBox.js";
import GenerationSettingsInfoTopics from "./GenerationSettingsInfoTopics.js";


/**
 * SettingsInfoButton
 *
 * A small "i" next to a setting that opens a dialog explaining it.
 *
 *     <settings-info-button topic="sectionMarksMode"></settings-info-button>
 *
 * Every explanation on this page used to be a native `title=` attribute, which
 * never appears on a touch device and cannot hold more than a sentence. This
 * renders the same help as a real dialog, so it is reachable on a phone and has
 * room for a worked example.
 *
 * The button reuses DialogBox.modal, which already supplies the backdrop, the
 * pinned close button, Escape handling through PopupStack, and the portrait
 * size caps in DialogBox.css — so there is no second dismissal path to keep in
 * step with the rest of the app.
 *
 * The topic is read on click rather than on connect: a component may set the
 * attribute after inserting the element, and a stale lookup would silently open
 * the wrong panel.
 */
class SettingsInfoButton extends HTMLElement
{
    static tagName = "settings-info-button";

    static TOPIC_ATTRIBUTE = "topic";

    connectedCallback()
    {
        if (this.dataset.initialized === "true")
        {
            return;
        }
        this.dataset.initialized = "true";

        const topicKey = this.getAttribute(SettingsInfoButton.TOPIC_ATTRIBUTE) || "";
        const topic = GenerationSettingsInfoTopics.resolveTopic(topicKey);
        const accessibleLabel = topic !== null ? `What does "${topic.title}" mean?` : "More information";

        this.innerHTML =
        `
            <button type="button" class="settings-info-button-trigger" aria-label="${SettingsInfoButton.#escapeHtml(accessibleLabel)}" title="${SettingsInfoButton.#escapeHtml(accessibleLabel)}">i</button>
        `;

        this.querySelector(".settings-info-button-trigger").addEventListener("click", (clickEvent) =>
        {
            // The button often sits inside a <label>, where a click would
            // otherwise be forwarded to the label's control — opening the help
            // for a checkbox would toggle it.
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            this.#openInformationDialog();
        });
    }

    #openInformationDialog()
    {
        const topicKey = this.getAttribute(SettingsInfoButton.TOPIC_ATTRIBUTE) || "";
        const topic = GenerationSettingsInfoTopics.resolveTopic(topicKey);

        if (topic === null)
        {
            console.warn(`SettingsInfoButton: no explanation is registered for topic "${topicKey}".`);
            return;
        }

        DialogBox.modal(
        `
            <div class="settings-info-dialog">
                <div class="settings-info-dialog-title">${SettingsInfoButton.#escapeHtml(topic.title)}</div>
                <div class="settings-info-dialog-body">${topic.bodyHtml}</div>
            </div>
        `);
    }

    /**
     * Topic titles are authored in this repository, not user input — this is
     * defence in depth so a future topic sourced from elsewhere cannot inject
     * markup through the label or the heading.
     */
    static #escapeHtml(rawString)
    {
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define(SettingsInfoButton.tagName, SettingsInfoButton);
export default SettingsInfoButton;
