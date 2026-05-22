import { enumerationToTitleCase } from "./EnumerationToTitleCase.js";

/**
 * Populates a select element with options based on a provided enumeration object.
 * @param {HTMLSelectElement} selectElement - The select element to populate.
 * @param {Object} enumObject - The enumeration object (key-value pairs).
 */
export function convertElementToEnumSelect(selectElement, enumObject) 
{

    selectElement.innerHTML = '';

    Object.keys(enumObject).forEach((key) => 
    {
        const option = document.createElement('option');
        
        option.value = key;
        option.textContent = enumerationToTitleCase(key);

        selectElement.appendChild(option);
    });
}