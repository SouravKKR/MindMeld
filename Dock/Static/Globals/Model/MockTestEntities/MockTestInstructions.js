import MockTestItem from "./MockTestItem.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";

class MockTestInstructions extends MockTestItem 
{
    #content = "";

    constructor(id, content = "") 
    {
        super(id, mockTestItemTypes.INSTRUCTIONS);
        this.#content = content;
    }

    getContent() { return this.#content; }
    setContent(content) { this.#content = content; }

    toJson() 
    {
        return {
            ...super.toJson(),
            content: this.#content
        };
    }

    static fromJson(json) 
    {
        return new MockTestInstructions(json.id, json.content);
    }
}

export default MockTestInstructions;