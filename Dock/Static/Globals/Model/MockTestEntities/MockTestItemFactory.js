import MockTestQuestion from "./MockTestQuestion.js";
import MockTestTitle from "./MockTestTitle.js";
import MockTestInstructions from "./MockTestInstructions.js";
import MockTestSection from "./MockTestSection.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";

class MockTestItemFactory
{
    static fromJson(json)
    {
        switch (json.type)
        {
            case mockTestItemTypes.SECTION:      return MockTestSection.fromJson(json);
            case mockTestItemTypes.INSTRUCTIONS: return MockTestInstructions.fromJson(json);
            case mockTestItemTypes.TITLE:        return MockTestTitle.fromJson(json);
            case mockTestItemTypes.QUESTION:     return MockTestQuestion.fromJson(json);
            default: throw new Error("Unknown MockTestItem type: " + json.type);
        }
    }
}

export default MockTestItemFactory;
