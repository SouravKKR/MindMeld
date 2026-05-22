const { authenticationProviders } = require('../Enumerations/AuthenticationProviders');
const { userRoles } = require('../Enumerations/UserRoles');

class User
{
    #id;
    #displayName;
    #provider;
    #joinDate;
    #preferences;
    #role;
    #profilePictureUrl;
    #additionalData;

    constructor({id = null, displayName = null, provider = 0, joinDate = new Date(), preferences = null, role = 0, profilePictureUrl = '', additionalData = null} = {})
    {
        this.setId(id);
        this.setDisplayName(displayName);
        this.setProvider(provider);
        this.setJoinDate(joinDate);
        this.setPreferences(preferences);
        this.setRole(role);
        this.setProfilePictureUrl(profilePictureUrl);
        this.setAdditionalData(additionalData);
    }

    getId()
    {
        return this.#id;
    }

    setId(value)
    {
        if (value !== null)
        {
            value = String(value);
        }
        this.#id = value;
    }

    getDisplayName()
    {
        return this.#displayName;
    }

    setDisplayName(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 256)
            {
                value = value.slice(0, 256);
            }
            if (value.length < 1)
            {
                value = null;
            }
        }
        this.#displayName = value;
    }

    getProvider()
    {
        return this.#provider;
    }

    setProvider(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(authenticationProviders);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#provider = value;
    }

    getJoinDate()
    {
        return this.#joinDate;
    }

    setJoinDate(value)
    {
        if (value !== null)
        {
            value = value instanceof Date ? value : new Date(value);
            if (isNaN(value.getTime()))
            {
                value = new Date();
            }
        }
        else
        {
            value = new Date();
        }
        this.#joinDate = value;
    }

    getPreferences()
    {
        return this.#preferences;
    }

    setPreferences(value)
    {
        this.#preferences = value;
    }

    getRole()
    {
        return this.#role;
    }

    setRole(value)
    {
        if (value !== null)
        {
            const enumValues = Object.values(userRoles);
            if (!enumValues.includes(value))
            {
                value = enumValues[0] ?? null;
            }
        }
        this.#role = value;
    }

    getProfilePictureUrl()
    {
        return this.#profilePictureUrl;
    }

    setProfilePictureUrl(value)
    {
        if (value !== null)
        {
            value = String(value);
            if (value.length > 2048)
            {
                value = value.slice(0, 2048);
            }
        }
        this.#profilePictureUrl = value;
    }

    getAdditionalData()
    {
        return this.#additionalData;
    }

    setAdditionalData(value)
    {
        this.#additionalData = value;
    }

    toJson()
    {
        return {
            id: this.getId(),
            displayName: this.getDisplayName(),
            provider: this.getProvider() !== null ? Number(this.getProvider()) : null,
            joinDate: this.getJoinDate() !== null ? this.getJoinDate().toISOString() : null,
            preferences: this.getPreferences(),
            role: this.getRole() !== null ? Number(this.getRole()) : null,
            profilePictureUrl: this.getProfilePictureUrl(),
            additionalData: this.getAdditionalData(),
        };
    }

    static fromJson(json)
    {
        const instance = new User({
            id: json.id ?? null,
            displayName: json.displayName ?? null,
            provider: json.provider ?? null,
            joinDate: json.joinDate != null ? new Date(json.joinDate) : null,
            preferences: json.preferences ?? null,
            role: json.role ?? null,
            profilePictureUrl: json.profilePictureUrl ?? null,
            additionalData: json.additionalData ?? null
        });
        return instance;
    }
}

module.exports = User;
