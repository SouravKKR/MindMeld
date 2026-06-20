import AudioSettingsManager from "./Audio/AudioSettingsManager.js";

/**
 * Centralised UI sound-effect player. Two responsibilities beyond playback:
 *
 *  - Volume / enable come from AudioSettingsManager (device-level prefs), read
 *    on every play so the Audio settings panel takes effect immediately.
 *
 *  - Autoplay unlock — no opt-in, no prompt. Audio is on by default (users can
 *    mute it in Settings → Audio). Web browsers reject Audio.play() until the
 *    page has seen a user gesture, and badge celebrations can pop automatically
 *    at app bootstrap (no gesture yet). So an auto-clip is BOTH attempted
 *    immediately (this just works on platforms without an autoplay gate, e.g.
 *    the desktop app) AND held as pending behind a one-time global gesture
 *    listener, so on the web the held jingle fires the instant the user first
 *    interacts. A successful immediate play clears the pending copy so the
 *    gesture never replays it.
 */
class SoundEffects
{
    static #OK_SOUND_PATH = "./Globals/Assets/Sounds/ButtonClickOkSound.mp3";
    static #CANCEL_SOUND_PATH = "./Globals/Assets/Sounds/ButtonClickCancelSound.wav";
    static #PURCHASE_SUCCESS_SOUND_PATH = "./Globals/Assets/Sounds/PurchaseSuccess.mp3";

    static #okAudio = null;
    static #cancelAudio = null;

    static #isUnlocked = false;
    static #unlockListenerInstalled = false;
    static #pendingClipPath = null;
    static #readyResolvers = [];

    static
    {
        SoundEffects.#installUnlockListener();
    }

    static isEnabled()
    {
        return AudioSettingsManager.getEnabled();
    }

    /** Affirmative / primary action cue (OK, confirm, continue). */
    static playOk()
    {
        SoundEffects.#playReusable(SoundEffects.#getOkAudio());
    }

    /** Dismissive / negative action cue (Cancel, close). */
    static playCancel()
    {
        SoundEffects.#playReusable(SoundEffects.#getCancelAudio());
    }

    /** Plays the purchase-success jingle. */
    static playPurchaseSuccess()
    {
        SoundEffects.playClip(SoundEffects.#PURCHASE_SUCCESS_SOUND_PATH);
    }

    /**
     * One-shot playback of an arbitrary sound file at the current volume. A
     * fresh Audio is created per call so a longer clip (an achievement jingle)
     * never clobbers the short button sounds. If audio is not yet unlocked the
     * clip is held and played on the first user gesture. No-op when disabled or
     * given an empty path.
     * @param {string} path
     */
    static playClip(path)
    {
        if (!AudioSettingsManager.getEnabled() || typeof path !== "string" || path.length === 0)
        {
            return;
        }

        if (!SoundEffects.#isUnlocked)
        {
            // Best effort: try to play right now (works on platforms without an
            // autoplay gate, e.g. the desktop app). If the browser blocks it, the
            // clip is held and fired on the first user gesture. A successful
            // immediate play marks audio unlocked and clears the pending copy so
            // the gesture doesn't replay it.
            SoundEffects.#pendingClipPath = path;
            SoundEffects.#installUnlockListener();
            SoundEffects.#playPath(path, () =>
            {
                if (SoundEffects.#pendingClipPath === path)
                {
                    SoundEffects.#pendingClipPath = null;
                }
                SoundEffects.#markUnlocked();
            });
            return;
        }

        SoundEffects.#playPath(path);
    }

    /**
     * Resolves when audio playback is permitted — immediately if already
     * unlocked, otherwise on the first user gesture. Lets an auto-appearing
     * celebration hold its popup until the jingle can sound in sync with it,
     * rather than the jingle being deferred to a later click.
     * @returns {Promise<void>}
     */
    static whenReady()
    {
        if (SoundEffects.#isUnlocked)
        {
            return Promise.resolve();
        }
        SoundEffects.#installUnlockListener();
        return new Promise((resolve) =>
        {
            SoundEffects.#readyResolvers.push(resolve);
        });
    }

    /**
     * Marks audio as usable and flushes any pending clip. Installed on the first
     * user gesture anywhere on the page (pointerdown / keydown / click), which
     * provides the activation the browser requires.
     */
    static unlock()
    {
        if (SoundEffects.#isUnlocked)
        {
            return;
        }

        if (SoundEffects.#pendingClipPath)
        {
            const pending = SoundEffects.#pendingClipPath;
            SoundEffects.#pendingClipPath = null;
            SoundEffects.#playPath(pending);
        }

        SoundEffects.#markUnlocked();
    }

    // Marks audio usable and releases anyone waiting on whenReady(). Idempotent.
    static #markUnlocked()
    {
        SoundEffects.#isUnlocked = true;

        if (SoundEffects.#readyResolvers.length > 0)
        {
            const resolvers = SoundEffects.#readyResolvers;
            SoundEffects.#readyResolvers = [];
            for (const resolve of resolvers)
            {
                resolve();
            }
        }
    }

    static #installUnlockListener()
    {
        if (SoundEffects.#unlockListenerInstalled || typeof window === "undefined")
        {
            return;
        }
        SoundEffects.#unlockListenerInstalled = true;

        const onFirstGesture = () =>
        {
            SoundEffects.unlock();
        };

        // Capture phase + once: the very first interaction anywhere unlocks audio.
        window.addEventListener("pointerdown", onFirstGesture, { once: true, capture: true });
        window.addEventListener("keydown", onFirstGesture, { once: true, capture: true });
        window.addEventListener("click", onFirstGesture, { once: true, capture: true });
    }

    static #playPath(path, onPlayed)
    {
        try
        {
            const audio = new Audio(path);
            audio.volume = AudioSettingsManager.getVolume();
            const playback = audio.play();
            if (playback && typeof playback.then === "function")
            {
                playback.then(() =>
                {
                    if (typeof onPlayed === "function")
                    {
                        onPlayed();
                    }
                }).catch(() => {});
            }
        }
        catch (playbackError)
        {
            // Autoplay restriction or load failure — non-fatal.
        }
    }

    static #getOkAudio()
    {
        if (!SoundEffects.#okAudio)
        {
            SoundEffects.#okAudio = new Audio(SoundEffects.#OK_SOUND_PATH);
            SoundEffects.#okAudio.preload = "auto";
        }
        return SoundEffects.#okAudio;
    }

    static #getCancelAudio()
    {
        if (!SoundEffects.#cancelAudio)
        {
            SoundEffects.#cancelAudio = new Audio(SoundEffects.#CANCEL_SOUND_PATH);
            SoundEffects.#cancelAudio.preload = "auto";
        }
        return SoundEffects.#cancelAudio;
    }

    static #playReusable(audio)
    {
        if (!AudioSettingsManager.getEnabled() || !audio)
        {
            return;
        }

        // Button cues are triggered by clicks (a gesture), so they are inherently
        // unlocked; mark unlocked so any later auto-clip also plays.
        SoundEffects.#markUnlocked();

        try
        {
            audio.volume = AudioSettingsManager.getVolume();
            audio.currentTime = 0;
            const playback = audio.play();
            if (playback && typeof playback.catch === "function")
            {
                playback.catch(() => {});
            }
        }
        catch (playbackError)
        {
            // Non-fatal.
        }
    }
}

export default SoundEffects;
