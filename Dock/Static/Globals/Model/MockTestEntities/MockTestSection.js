import MockTestItem from "./MockTestItem.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";
class MockTestSection extends MockTestItem 
{
    #title = "";
    #description = "";

    constructor(id, title = "", description = "") 
    {
        super(id, mockTestItemTypes.SECTION);
        this.#title = title;
        this.#description = description;
    }

    getTitle() { return this.#title; }
    setTitle(title) { this.#title = title; }
    
    getDescription() { return this.#description; }
    setDescription(description) { this.#description = description; }

    toJson() 
    {
        return {
            ...super.toJson(),
            title: this.#title,
            description: this.#description
        };
    }

    static fromJson(json) 
    {
        return new MockTestSection(json.id, json.title, json.description);
    }
}

export default MockTestSection;
