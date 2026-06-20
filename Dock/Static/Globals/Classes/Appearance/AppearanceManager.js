import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import ThemeVariableRegistry from "./ThemeVariableRegistry.js";

/**
 * AppearanceManager
 *
 * Owns the runtime application + persistence of the user's Appearance
 * settings (CSS variable overrides, font family, page zoom). Bootstrapped
 * once at page load via the static block — subscribes to
 * ON_USER_LOGGED_IN / ON_USER_LOGGED_OUT and applies / reverts theme
 * overrides accordingly.
 *
 * Storage shape on the server:
 *   user.additionalData.settings.appearance = {
 *       cssVariables: { "--var-name": "value", ... },
 *       fontFamily: "GoogleSans",
 *       zoom: 1.0
 *   }
 *
 * Always serialises the full `settings` blob to /UpdateUserAdditionalData
 * so the backend's top-level shallow merge does not clobber sibling
 * settings sub-objects added by future submenus.
 */
class AppearanceManager
{
    static FONT_FAMILY_CSS_VARIABLE = "--app-font-family";
    static ZOOM_CSS_VARIABLE = "--app-zoom";
    static SERVER_DEBOUNCE_MILLISECONDS = 500;

    static #appliedVariableNames = new Set();
    static #appliedFontFamily = false;
    static #appliedZoom = false;
    static #currentAppearance = AppearanceManager.#emptyAppearance();
    static #pendingTimeoutId = null;
    static #listeners = new Set();
    static #hasBound = false;

    static
    {
        AppearanceManager.#bindOnce();
    }

    static #bindOnce()
    {
        if (AppearanceManager.#hasBound)
        {
            return;
        }
        AppearanceManager.#hasBound = true;

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, (event) =>
        {
            const user = event?.detail?.user ?? window["user"];
            AppearanceManager.#hydrateFromUser(user);
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            AppearanceManager.#revertAll();
            AppearanceManager.#currentAppearance = AppearanceManager.#emptyAppearance();
            AppearanceManager.#notifyListeners();
        });
    }

    static #emptyAppearance()
    {
        return { cssVariables: {}, fontFamily: null, zoom: null };
    }

    static #hydrateFromUser(user)
    {
        if (!user)
        {
            return;
        }

        const additionalData = user.getAdditionalData?.() ?? {};
        const settings = additionalData.settings ?? {};
        const appearance = settings.appearance ?? null;

        if (!appearance)
        {
            AppearanceManager.#currentAppearance = AppearanceManager.#emptyAppearance();
            AppearanceManager.#notifyListeners();
            return;
        }

        AppearanceManager.#currentAppearance =
        {
            cssVariables: { ...(appearance.cssVariables ?? {}) },
            fontFamily: appearance.fontFamily ?? null,
            zoom: typeof appearance.zoom === "number" ? appearance.zoom : null,
        };

        AppearanceManager.#applyToDocument(AppearanceManager.#currentAppearance);
        AppearanceManager.#notifyListeners();
    }

    static #applyToDocument(appearance)
    {
        const rootElement = document.documentElement;

        if (appearance.cssVariables)
        {
            for (const [variableName, value] of Object.entries(appearance.cssVariables))
            {
                if (value === null || value === undefined || value === "")
                {
                    rootElement.style.removeProperty(variableName);
                    AppearanceManager.#appliedVariableNames.delete(variableName);
                }
                else
                {
                    rootElement.style.setProperty(variableName, value);
                    AppearanceManager.#appliedVariableNames.add(variableName);
                }
            }
        }

        if (appearance.fontFamily)
        {
            rootElement.style.setProperty(AppearanceManager.FONT_FAMILY_CSS_VARIABLE, appearance.fontFamily);
            AppearanceManager.#appliedFontFamily = true;
        }
        else
        {
            rootElement.style.removeProperty(AppearanceManager.FONT_FAMILY_CSS_VARIABLE);
            AppearanceManager.#appliedFontFamily = false;
        }

        if (typeof appearance.zoom === "number" && isFinite(appearance.zoom))
        {
            rootElement.style.setProperty(AppearanceManager.ZOOM_CSS_VARIABLE, String(appearance.zoom));
            AppearanceManager.#appliedZoom = true;
        }
        else
        {
            rootElement.style.removeProperty(AppearanceManager.ZOOM_CSS_VARIABLE);
            AppearanceManager.#appliedZoom = false;
        }
    }

    static #revertAll()
    {
        const rootElement = document.documentElement;

        for (const variableName of AppearanceManager.#appliedVariableNames)
        {
            rootElement.style.removeProperty(variableName);
        }
        AppearanceManager.#appliedVariableNames.clear();

        if (AppearanceManager.#appliedFontFamily)
        {
            rootElement.style.removeProperty(AppearanceManager.FONT_FAMILY_CSS_VARIABLE);
            AppearanceManager.#appliedFontFamily = false;
        }

        if (AppearanceManager.#appliedZoom)
        {
            rootElement.style.removeProperty(AppearanceManager.ZOOM_CSS_VARIABLE);
            AppearanceManager.#appliedZoom = false;
        }

        if (AppearanceManager.#pendingTimeoutId !== null)
        {
            clearTimeout(AppearanceManager.#pendingTimeoutId);
            AppearanceManager.#pendingTimeoutId = null;
        }
    }

    /**
     * Returns the current effective appearance, with defaults filled in
     * from ThemeVariableRegistry for any unset value. Used by the panel
     * to seed inputs on first render.
     */
    static getEffective()
    {
        const cssVariables = {};
        for (const entry of ThemeVariableRegistry.getAll())
        {
            cssVariables[entry.name] = AppearanceManager.#currentAppearance.cssVariables[entry.name] ?? entry.defaultValue;
        }

        return {
            cssVariables,
            fontFamily: AppearanceManager.#currentAppearance.fontFamily ?? ThemeVariableRegistry.DEFAULT_FONT_FAMILY,
            zoom: AppearanceManager.#currentAppearance.zoom ?? ThemeVariableRegistry.DEFAULT_ZOOM,
        };
    }

    /**
     * Returns the raw stored appearance (only fields the user has actually
     * overridden). Defaults are NOT filled in.
     */
    static getStored()
    {
        return {
            cssVariables: { ...AppearanceManager.#currentAppearance.cssVariables },
            fontFamily: AppearanceManager.#currentAppearance.fontFamily,
            zoom: AppearanceManager.#currentAppearance.zoom,
        };
    }

    /**
     * Update one or more appearance fields. Applies to the DOM immediately
     * and schedules a debounced server write. partialAppearance may contain
     * any subset of:
     *   { cssVariables: { "--name": value, ... }, fontFamily: "...", zoom: 1.1 }
     */
    static update(partialAppearance)
    {
        if (!partialAppearance || typeof partialAppearance !== "object")
        {
            return;
        }

        if (partialAppearance.cssVariables && typeof partialAppearance.cssVariables === "object")
        {
            AppearanceManager.#currentAppearance.cssVariables =
            {
                ...AppearanceManager.#currentAppearance.cssVariables,
                ...partialAppearance.cssVariables,
            };
        }

        if ("fontFamily" in partialAppearance)
        {
            AppearanceManager.#currentAppearance.fontFamily = partialAppearance.fontFamily ?? null;
        }

        if ("zoom" in partialAppearance)
        {
            const zoomNumber = Number(partialAppearance.zoom);
            AppearanceManager.#currentAppearance.zoom = isFinite(zoomNumber) ? zoomNumber : null;
        }

        AppearanceManager.#applyToDocument(AppearanceManager.#currentAppearance);
        AppearanceManager.#notifyListeners();
        AppearanceManager.#schedulePersist();
    }

    /**
     * Resets a single variable / field back to its default. For CSS
     * variables, "default" means whatever ThemeVariableRegistry declares.
     */
    static resetVariable(variableName)
    {
        const cssVariablesCopy = { ...AppearanceManager.#currentAppearance.cssVariables };
        delete cssVariablesCopy[variableName];
        AppearanceManager.#currentAppearance.cssVariables = cssVariablesCopy;

        document.documentElement.style.removeProperty(variableName);
        AppearanceManager.#appliedVariableNames.delete(variableName);

        AppearanceManager.#notifyListeners();
        AppearanceManager.#schedulePersist();
    }

    /**
     * Clears every override. Both the in-memory state and the document
     * styles revert to Theme.css defaults.
     */
    static resetAll()
    {
        AppearanceManager.#revertAll();
        AppearanceManager.#currentAppearance = AppearanceManager.#emptyAppearance();
        AppearanceManager.#notifyListeners();
        AppearanceManager.#schedulePersist();
    }

    static onChange(listener)
    {
        AppearanceManager.#listeners.add(listener);
        return () => AppearanceManager.#listeners.delete(listener);
    }

    static #notifyListeners()
    {
        for (const listener of AppearanceManager.#listeners)
        {
            try
            {
                listener(AppearanceManager.getEffective());
            }
            catch (listenerError)
            {
                console.error("[AppearanceManager] listener threw:", listenerError);
            }
        }
    }

    static #schedulePersist()
    {
        if (AppearanceManager.#pendingTimeoutId !== null)
        {
            clearTimeout(AppearanceManager.#pendingTimeoutId);
        }

        AppearanceManager.#pendingTimeoutId = setTimeout(async () =>
        {
            AppearanceManager.#pendingTimeoutId = null;
            await AppearanceManager.#persistNow();
        }, AppearanceManager.SERVER_DEBOUNCE_MILLISECONDS);
    }

    static async #persistNow()
    {
        const user = window["user"];
        if (!user)
        {
            return;
        }

        const additionalData = user.getAdditionalData?.() ?? {};
        const existingSettings = additionalData.settings ?? {};

        const nextAppearance = AppearanceManager.#serialiseAppearance();
        const nextSettings = { ...existingSettings, appearance: nextAppearance };

        try
        {
            const response = await fetch("/UpdateUserAdditionalData",
            {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ partialAdditionalData: { settings: nextSettings } }),
            });

            if (!response.ok)
            {
                console.warn("[AppearanceManager] /UpdateUserAdditionalData returned", response.status);
                return;
            }

            const responseJson = await response.json();
            const serverAdditionalData = responseJson?.additionalData;
            if (serverAdditionalData && typeof user.setAdditionalData === "function")
            {
                user.setAdditionalData(serverAdditionalData);
                sessionStorage.setItem("user", JSON.stringify(user.toJson()));
            }
        }
        catch (networkError)
        {
            console.warn("[AppearanceManager] failed to persist appearance:", networkError);
        }
    }

    static #serialiseAppearance()
    {
        const serialised = {};

        if (Object.keys(AppearanceManager.#currentAppearance.cssVariables).length > 0)
        {
            serialised.cssVariables = { ...AppearanceManager.#currentAppearance.cssVariables };
        }

        if (AppearanceManager.#currentAppearance.fontFamily)
        {
            serialised.fontFamily = AppearanceManager.#currentAppearance.fontFamily;
        }

        if (typeof AppearanceManager.#currentAppearance.zoom === "number")
        {
            serialised.zoom = AppearanceManager.#currentAppearance.zoom;
        }

        return serialised;
    }
}

export default AppearanceManager;
