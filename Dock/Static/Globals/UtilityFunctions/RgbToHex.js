export function rgbToHex(rgb)
{
    const m = rgb.match(/\d+/g);
    if (!m) return "#ffff00";
    return "#" + m.map(x => (+x).toString(16).padStart(2, "0")).join("");
}
