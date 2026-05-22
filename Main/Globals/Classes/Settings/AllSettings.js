import { settingsMenus } from '../../Enumerations/SettingsMenus.js';
import ProfileSettings from './ProfileSettings.js';

class AllSettings
{
    #settingsMap;

    constructor()
    {
        this.#settingsMap = new Map([
            [settingsMenus.PROFILE, new ProfileSettings()]
        ]);
    }

    getSettingsMap()
    {
        return this.#settingsMap;
    }

    getSettings(key)
    {
        return this.#settingsMap.get(key);
    }

    loadFromUser(user)
    {
        for (const settings of this.#settingsMap.values())
        {
            settings.loadFromUser(user);
        }
    }
}

export default AllSettings;
