import { getRandomUuid } from "../../UtilityFunctions/GetRandomUuid.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";

class MockTestItem 
{
    #id = "";
    #type = null;

    constructor(id, type) 
    {
        this.#id = id || getRandomUuid();
        this.#type = type;
    }

    getId() { return this.#id; }
    getType() { return this.#type; }

    toJson() 
    {
        return {
            id: this.#id,
            type: this.#type
        };
    }
}

export { mockTestItemTypes };
export default MockTestItem;
