import TextSearchFilterInput from "./TextSearchFilterInput.js";
import NumberRangeFilterInput from "./NumberRangeFilterInput.js";
import DateRangeFilterInput from "./DateRangeFilterInput.js";
import MultiSelectFilterInput from "./MultiSelectFilterInput.js";
import EnumFilterInput from "./EnumFilterInput.js";
import BooleanFilterInput from "./BooleanFilterInput.js";
import InstituteSelectFilterInput from "./InstituteSelectFilterInput.js";
import { paidDeckFilterTypes } from "../../../Globals/Enumerations/PaidDeckFilterTypes.js";

/**
 * PaidDeckFilterInputFactory
 *
 * Single point of mapping between a filter-type enum value and the
 * concrete client-side input class. Adding a new filter type means:
 *   1. Define the enum value in Common/Enumerations/PaidDeckFilterTypes.json.
 *   2. Add a server filter class that outputs that type from getMetadata().
 *   3. Add a client input class implementing PaidDeckFilterInput.
 *   4. Add one line to the switch below.
 * The library page itself never needs to change.
 */
class PaidDeckFilterInputFactory
{
    static create(metadata, onChangeCallback)
    {
        switch (metadata.type)
        {
            case paidDeckFilterTypes.TEXT_SEARCH:
                return new TextSearchFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.NUMBER_RANGE:
                return new NumberRangeFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.DATE_RANGE:
                return new DateRangeFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.MULTI_SELECT:
                return new MultiSelectFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.ENUM:
                return new EnumFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.BOOLEAN:
                return new BooleanFilterInput(metadata, onChangeCallback);
            case paidDeckFilterTypes.INSTITUTE_SELECT:
                return new InstituteSelectFilterInput(metadata, onChangeCallback);
            default:
                console.warn(`[PaidDeckFilterInputFactory] Unknown filter type ${metadata.type} for key ${metadata.key}`);
                return null;
        }
    }
}

export default PaidDeckFilterInputFactory;
