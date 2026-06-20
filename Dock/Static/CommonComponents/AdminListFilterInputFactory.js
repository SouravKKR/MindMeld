import TextSearchFilterInput from "../Pages/PaidDeckLibrary/Components/TextSearchFilterInput.js";
import NumberRangeFilterInput from "../Pages/PaidDeckLibrary/Components/NumberRangeFilterInput.js";
import DateRangeFilterInput from "../Pages/PaidDeckLibrary/Components/DateRangeFilterInput.js";
import MultiSelectFilterInput from "../Pages/PaidDeckLibrary/Components/MultiSelectFilterInput.js";
import EnumFilterInput from "../Pages/PaidDeckLibrary/Components/EnumFilterInput.js";
import BooleanFilterInput from "../Pages/PaidDeckLibrary/Components/BooleanFilterInput.js";
import { paidDeckFilterTypes } from "../Globals/Enumerations/PaidDeckFilterTypes.js";

/**
 * AdminListFilterInputFactory
 *
 * Maps a server filter-type enum value to the concrete client input control,
 * reusing the exact input classes the paid-deck library already ships (the
 * generic admin list and the paid-deck search share one filter-input
 * vocabulary). The INSTITUTE_SELECT type is intentionally omitted — admin
 * lists never use it.
 */
class AdminListFilterInputFactory
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
            default:
                console.warn(`[AdminListFilterInputFactory] Unsupported filter type ${metadata.type} for key ${metadata.key}`);
                return null;
        }
    }
}

export default AdminListFilterInputFactory;
