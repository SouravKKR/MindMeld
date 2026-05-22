import MockTestItem from "./MockTestItem.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";

class MockTestTitle extends MockTestItem 
{
    #title = "";

    constructor(id, title = "") 
    {
        super(id, mockTestItemTypes.TITLE);
        this.#title = title;
    }

    getTitle() { return this.#title; }
    setTitle(title) { this.#title = title; }

    toJson() 
    {
        return {
            ...super.toJson(),
            title: this.#title
        };
    }

    static fromJson(json) 
    {
        return new MockTestTitle(json.id, json.title);
    }
}

export default MockTestTitle;