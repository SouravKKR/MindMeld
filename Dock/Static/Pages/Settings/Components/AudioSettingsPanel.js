import AudioSettingsManager from "../../../Globals/Classes/Audio/AudioSettingsManager.js";
import SoundEffects from "../../../Globals/Classes/SoundEffects.js";

/**
 * <audio-settings-panel>
 *
 * Embedded in the Settings AUDIO tab. An enable toggle, a volume slider, and a
 * Test-sound button. Edits flow through AudioSettingsManager (device-level,
 * localStorage) and take effect on the next SoundEffects play immediately.
 */
class AudioSettingsPanel extends HTMLElement
{
    static #TEST_SOUND_PATH = "./Globals/Assets/Sounds/Achievements/VictoryLevel1.mp3";

    #unsubscribe = null;

    connectedCallback()
    {
        this.#render();
        this.#unsubscribe = AudioSettingsManager.onChange(() =>
        {
            if (this.isConnected)
            {
                this.#syncControls();
            }
        });
    }

    disconnectedCallback()
    {
        if (this.#unsubscribe)
        {
            this.#unsubscribe();
            this.#unsubscribe = null;
        }
    }

    #render()
    {
        const enabled = AudioSettingsManager.getEnabled();
        const volumePercent = Math.round(AudioSettingsManager.getVolume() * 100);

        this.innerHTML =
        `
            <div class="audio-settings">
                <div class="audio-settings-row">
                    <span class="audio-settings-label">Sound effects</span>
                    <label class="audio-settings-switch">
                        <input type="checkbox" class="audio-settings-enabled" ${enabled ? "checked" : ""}>
                        <span class="audio-settings-switch-track"></span>
                    </label>
                </div>
                <div class="audio-settings-row">
                    <span class="audio-settings-label">Volume</span>
                    <input type="range" class="audio-settings-volume" min="0" max="100" value="${volumePercent}" ${enabled ? "" : "disabled"}>
                    <span class="audio-settings-volume-value">${volumePercent}%</span>
                </div>
                <button type="button" class="settings-cta-button audio-settings-test" ${enabled ? "" : "disabled"}>Test sound</button>
            </div>
        `;

        const enabledToggle = this.querySelector(".audio-settings-enabled");
        const volumeSlider = this.querySelector(".audio-settings-volume");
        const volumeValue = this.querySelector(".audio-settings-volume-value");
        const testButton = this.querySelector(".audio-settings-test");

        enabledToggle.addEventListener("change", () =>
        {
            AudioSettingsManager.setEnabled(enabledToggle.checked);
            if (enabledToggle.checked)
            {
                // The toggle click is a gesture — unlock audio and confirm with a sample.
                SoundEffects.unlock();
                SoundEffects.playClip(AudioSettingsPanel.#TEST_SOUND_PATH);
            }
        });

        volumeSlider.addEventListener("input", () =>
        {
            AudioSettingsManager.setVolume(Number(volumeSlider.value) / 100);
            volumeValue.textContent = `${volumeSlider.value}%`;
        });

        volumeSlider.addEventListener("change", () =>
        {
            SoundEffects.playClip(AudioSettingsPanel.#TEST_SOUND_PATH);
        });

        testButton.addEventListener("click", () =>
        {
            SoundEffects.playClip(AudioSettingsPanel.#TEST_SOUND_PATH);
        });
    }

    #syncControls()
    {
        const enabled = AudioSettingsManager.getEnabled();
        const volumePercent = Math.round(AudioSettingsManager.getVolume() * 100);

        const enabledToggle = this.querySelector(".audio-settings-enabled");
        const volumeSlider = this.querySelector(".audio-settings-volume");
        const volumeValue = this.querySelector(".audio-settings-volume-value");
        const testButton = this.querySelector(".audio-settings-test");

        if (enabledToggle)
        {
            enabledToggle.checked = enabled;
        }
        if (volumeSlider)
        {
            volumeSlider.value = String(volumePercent);
            volumeSlider.disabled = !enabled;
        }
        if (volumeValue)
        {
            volumeValue.textContent = `${volumePercent}%`;
        }
        if (testButton)
        {
            testButton.disabled = !enabled;
        }
    }
}

customElements.define("audio-settings-panel", AudioSettingsPanel);
export default AudioSettingsPanel;
