import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";

class GenerationFields extends HTMLElement
{
    static settingsClass = null;
    static settingsKey = "INVALID";
    static taskType = taskTypes.UNKNOWN;
    static tagName = "generation-fields";

    /**
     * Why the last validate() call returned false, phrased for the user, or
     * null when it passed or the subclass has nothing specific to say.
     *
     * validate() is a bare boolean, so the page could only ever show one
     * catch-all sentence — useless for a rule like "these sections cannot add
     * up to that many marks", where every individual value looks fine and only
     * the combination is wrong. Subclasses set this before returning false;
     * the page prefers it over its generic message.
     */
    _validationMessage = null;

    getValidationMessage()
    {
        return this._validationMessage;
    }

    static create()
    {
        const generationFieldsElement = document.createElement(this.tagName);
        generationFieldsElement.setSettings(new this.settingsClass());
        generationFieldsElement.getSettings().setType(this.taskType);
        generationFieldsElement.classList.add("generation-fields");
        return generationFieldsElement;
    }

    setSettings(settings)
    {
        if(this._settings == null)
        {
            this._settings = settings;
        }
        else
        {
            console.warn("Settings already set, not overriding.");
        }

    }

    getSettings()
    {
        return this._settings;
    }
}

customElements.define("generation-fields", GenerationFields);
export default GenerationFields;
