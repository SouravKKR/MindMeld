/**
 * Device-level audio preferences (enabled + volume), persisted in localStorage
 * so they never touch the server. SoundEffects reads these on every play, and
 * the Audio settings panel + the first-run enable prompt write through here.
 * Listeners are notified on change so any mounted control stays in sync.
 */
class AudioSettingsManager
{
    static #STORAGE_KEY = "cogniumlearn.audioSettings";
    static #DEFAULT_VOLUME = 0.7;

    static #cached = null;
    static #listeners = new Set();

    static #load()
    {
        if (AudioSettingsManager.#cached !== null)
        {
            return AudioSettingsManager.#cached;
        }

        let stored = null;
        try
        {
            const raw = window.localStorage.getItem(AudioSettingsManager.#STORAGE_KEY);
            stored = raw ? JSON.parse(raw) : null;
        }
        catch (readError)
        {
            stored = null;
        }

        AudioSettingsManager.#cached =
        {
            hasStored: Boolean(stored),
            enabled: stored && typeof stored.enabled === "boolean" ? stored.enabled : true,
            volume: stored && Number.isFinite(stored.volume) ? Math.min(1, Math.max(0, stored.volume)) : AudioSettingsManager.#DEFAULT_VOLUME,
        };
        return AudioSettingsManager.#cached;
    }

    static #persist()
    {
        const state = AudioSettingsManager.#load();
        try
        {
            window.localStorage.setItem(AudioSettingsManager.#STORAGE_KEY, JSON.stringify({ enabled: state.enabled, volume: state.volume }));
        }
        catch (writeError)
        {
            // Private mode / storage full — preferences just won't persist.
        }
        state.hasStored = true;
        for (const listener of AudioSettingsManager.#listeners)
        {
            listener();
        }
    }

    /** True once the user has made an explicit choice (gates the first-run prompt). */
    static hasStoredPreference()
    {
        return AudioSettingsManager.#load().hasStored;
    }

    static getEnabled()
    {
        return AudioSettingsManager.#load().enabled;
    }

    static getVolume()
    {
        return AudioSettingsManager.#load().volume;
    }

    static setEnabled(isEnabled)
    {
        AudioSettingsManager.#load().enabled = Boolean(isEnabled);
        AudioSettingsManager.#persist();
    }

    static setVolume(volume)
    {
        const clamped = Math.min(1, Math.max(0, Number(volume)));
        AudioSettingsManager.#load().volume = Number.isFinite(clamped) ? clamped : AudioSettingsManager.#DEFAULT_VOLUME;
        AudioSettingsManager.#persist();
    }

    /**
     * Subscribe to preference changes. Returns an unsubscribe function.
     * @param {Function} listener
     */
    static onChange(listener)
    {
        AudioSettingsManager.#listeners.add(listener);
        return () => AudioSettingsManager.#listeners.delete(listener);
    }
}

export default AudioSettingsManager;
