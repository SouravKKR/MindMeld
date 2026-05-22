import { rgbToHex } from "./RgbToHex.js";

export function convertElementToColorPicker(element)
{
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    
    colorPicker.addEventListener('input', () => element.style.backgroundColor = colorPicker.value);
    colorPicker.addEventListener('change', () => element.style.backgroundColor = colorPicker.value);
    colorPicker.addEventListener("click", event =>
    {
        event.stopPropagation();
    });

    colorPicker.value = "#ffffff"
    colorPicker.style.display = 'none';

    element.addEventListener('click', () => colorPicker.click());
    element.appendChild(colorPicker);

    colorPicker.dispatchEvent(new Event('input'));
}