import StreakBadgeHelper from "./StreakBadgeHelper.js";

/**
 * Injects the user's highest earned streak badge (image + name) into the top of
 * the profile dropdown — WITHOUT modifying ProfileContextMenu. A MutationObserver
 * watches document.body for the freshly-created `profile-context-menu` element
 * (ContextMenu appends it directly to body) and prepends a non-interactive
 * header. The menu's own ResizeObserver re-corrects its position after the size
 * change. Self-initialises on import; load once at boot.
 */
class ProfileBadgeInjector
{
    static #PROFILE_MENU_TAG_NAME = "PROFILE-CONTEXT-MENU";
    static #isInitialised = false;

    static
    {
        ProfileBadgeInjector.initialise();
    }

    static initialise()
    {
        if (ProfileBadgeInjector.#isInitialised)
        {
            return;
        }
        ProfileBadgeInjector.#isInitialised = true;

        const startObserving = () =>
        {
            const observer = new MutationObserver((mutations) =>
            {
                for (const mutation of mutations)
                {
                    for (const addedNode of mutation.addedNodes)
                    {
                        if (addedNode.nodeType === Node.ELEMENT_NODE && addedNode.tagName === ProfileBadgeInjector.#PROFILE_MENU_TAG_NAME)
                        {
                            ProfileBadgeInjector.#injectLatestBadge(addedNode);
                        }
                    }
                }
            });

            observer.observe(document.body, { childList: true });
        };

        if (document.body)
        {
            startObserving();
        }
        else
        {
            window.addEventListener("DOMContentLoaded", startObserving, { once: true });
        }
    }

    static #injectLatestBadge(menuElement)
    {
        // Guard against a double-inject if the same menu is observed twice.
        if (menuElement.querySelector(".profile-latest-badge"))
        {
            return;
        }

        const streakState = StreakBadgeHelper.getStreakState(window["user"]);
        if (streakState.earnedBadges.length === 0)
        {
            return;
        }

        const highestThreshold = streakState.earnedBadges.reduce((highest, badge) => Math.max(highest, badge.streak), 0);
        const definition = StreakBadgeHelper.findDefinitionByStreak(highestThreshold);
        if (!definition)
        {
            return;
        }

        const header = document.createElement("div");
        header.className = "profile-latest-badge";
        header.innerHTML =
        `
            <div class="profile-latest-badge-icon">
                <span class="profile-latest-badge-fallback">${StreakBadgeHelper.FALLBACK_BADGE_GLYPH}</span>
                <img src="${definition.imagePath}" alt="${definition.name}" onerror="this.remove()">
            </div>
            <div class="profile-latest-badge-text">
                <div class="profile-latest-badge-label">Latest badge</div>
                <div class="profile-latest-badge-name">${definition.name}</div>
            </div>
        `;

        menuElement.insertBefore(header, menuElement.firstChild);
    }
}

export default ProfileBadgeInjector;
