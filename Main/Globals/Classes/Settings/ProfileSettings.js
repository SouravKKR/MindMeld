import UserSetting from './UserSetting.js';
import { profileSettingKeys } from '../../Enumerations/ProfileSettingKeys.js';
import SettingFlags from '../../Constants/SettingFlags.js';

class ProfileSettings
{
    #credits;
    #displayName;
    #email;
    #joinDate;

    constructor()
    {
        this.#credits = new UserSetting({
            key: profileSettingKeys.CREDITS,
            defaultValue: 5,
            flags: SettingFlags.CALL_TO_ACTION,
            additionalData: { callToActionLabel: 'Buy Credits' }
        });
        this.#displayName = new UserSetting({ key: profileSettingKeys.DISPLAY_NAME, defaultValue: '' });
        this.#email = new UserSetting({ key: profileSettingKeys.EMAIL, defaultValue: '' });
        this.#joinDate = new UserSetting({ key: profileSettingKeys.JOIN_DATE, defaultValue: null });
    }

    loadFromUser(user)
    {
        const data = user.getAdditionalData() ?? {};
        this.#credits.setValue(data.credits ?? this.#credits.getDefaultValue());
        this.#displayName.setValue(user.getDisplayName() ?? this.#displayName.getDefaultValue());
        this.#email.setValue(data.email ?? this.#email.getDefaultValue());
        this.#joinDate.setValue(user.getJoinDate() ?? this.#joinDate.getDefaultValue());
    }

    getSettings()
    {
        return [this.#credits, this.#displayName, this.#email, this.#joinDate];
    }
}

export default ProfileSettings;
