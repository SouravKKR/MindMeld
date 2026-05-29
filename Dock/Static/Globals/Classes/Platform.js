import { platforms } from "../Enumerations/Platforms.js";


class Platform
{
    static get()
    {
        if(window.__TAURI__)
        {
            return platforms.APP;
        }
        else
        {
            return platforms.WEB;
        }
    }
}

export default Platform;