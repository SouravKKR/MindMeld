import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";

class GenerationFields extends HTMLElement
{
    static settingsClass = null;
    static settingsKey = "INVALID";
    static taskType = taskTypes.UNKNOWN;
    static tagName = "generation-fields";
    
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
