import AppearanceManager from "../../../Globals/Classes/Appearance/AppearanceManager.js";
import ThemeVariableRegistry from "../../../Globals/Classes/Appearance/ThemeVariableRegistry.js";

/**
 * <appearance-settings-panel>
 *
 * Embedded inside the Settings page's APPEARANCE tab. Renders an input
 * per ThemeVariableRegistry entry, plus a font-family dropdown, a page
 * zoom slider, and a global Reset button. All edits flow through
 * AppearanceManager.update(...) which applies the change to the
 * document immediately and debounces a server write.
 */
class AppearanceSettingsPanel extends HTMLElement
{
    static GRADIENT_VARIABLE_NAME = "--primary-background-gradient";
    static COLOR_PROBE = AppearanceSettingsPanel.#createColorProbe();

    #unsubscribe = null;
    #advancedGradient = false;

    static #createColorProbe()
    {
        if (typeof document === "undefined")
        {
            return null;
        }
        const probe = document.createElement("div");
        probe.style.display = "none";
        return probe;
    }

    connectedCallback()
    {
        this.#advancedGradient = !AppearanceSettingsPanel.#canDecomposeGradient(AppearanceManager.getEffective().cssVariables[AppearanceSettingsPanel.GRADIENT_VARIABLE_NAME]);
        this.#render();
        this.#unsubscribe = AppearanceManager.onChange(() =>
        {
            if (!this.isConnected)
            {
                return;
            }
            this.#refreshControls();
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
        const effective = AppearanceManager.getEffective();

        const groupSections = ThemeVariableRegistry.getGroups().map(groupName =>
        {
            const entries = ThemeVariableRegistry.getByGroup(groupName);
            if (entries.length === 0)
            {
                return "";
            }

            const rowsHtml = entries.map(entry => this.#renderEntryRow(entry, effective.cssVariables[entry.name])).join("");

            return `
                <section class="appearance-section" data-group="${groupName}">
                    <h3 class="appearance-section-title">${groupName}</h3>
                    <div class="appearance-section-rows">${rowsHtml}</div>
                </section>
            `;
        }).join("");

        this.innerHTML = `
            <div class="appearance-panel-root">
                ${groupSections}
                ${this.#renderTypographySection(effective)}
                ${this.#renderZoomSection(effective)}
                <div class="appearance-footer">
                    <button type="button" class="appearance-reset-all-button">Reset All to Defaults</button>
                </div>
            </div>
        `;

        this.#bindEventHandlers();
    }

    #renderEntryRow(entry, currentValue)
    {
        const resolvedValue = currentValue ?? entry.defaultValue;

        if (entry.type === "color")
        {
            const hex = AppearanceSettingsPanel.#toHexForPicker(resolvedValue);
            return `
                <div class="appearance-row" data-variable="${entry.name}" data-type="color">
                    <span class="appearance-row-label">${entry.label}</span>
                    <div class="appearance-row-controls">
                        <input class="appearance-color-picker" type="color" value="${hex}">
                        <input class="appearance-color-text" type="text" value="${this.#escapeAttribute(resolvedValue)}" spellcheck="false">
                        <button type="button" class="appearance-row-reset" title="Reset to default">Reset</button>
                    </div>
                </div>
            `;
        }

        if (entry.type === "gradient")
        {
            return this.#renderGradientRow(entry, resolvedValue);
        }

        return `
            <div class="appearance-row" data-variable="${entry.name}" data-type="${entry.type}">
                <span class="appearance-row-label">${entry.label}</span>
                <div class="appearance-row-controls">
                    <input class="appearance-text-input" type="text" value="${this.#escapeAttribute(resolvedValue)}" spellcheck="false">
                    <button type="button" class="appearance-row-reset" title="Reset to default">Reset</button>
                </div>
            </div>
        `;
    }

    #renderGradientRow(entry, currentValue)
    {
        const decomposed = AppearanceSettingsPanel.#decomposeGradient(currentValue) ?? AppearanceSettingsPanel.#decomposeGradient(entry.defaultValue);
        const angle = decomposed ? decomposed.angle : 45;
        const startColorHex = decomposed ? AppearanceSettingsPanel.#toHexForPicker(decomposed.startColor) : "#0098c4";
        const endColorHex = decomposed ? AppearanceSettingsPanel.#toHexForPicker(decomposed.endColor) : "#b55bd0";
        const advanced = this.#advancedGradient;

        return `
            <div class="appearance-row appearance-gradient-row" data-variable="${entry.name}" data-type="gradient" data-advanced="${advanced ? "1" : "0"}">
                <span class="appearance-row-label">${entry.label}</span>
                <div class="appearance-row-controls appearance-gradient-controls">
                    <div class="appearance-gradient-preview" style="background: ${this.#escapeAttribute(currentValue)};"></div>
                    <label class="appearance-gradient-toggle">
                        <input type="checkbox" class="appearance-gradient-advanced-toggle" ${advanced ? "checked" : ""}>
                        Advanced
                    </label>
                    <div class="appearance-gradient-decomposed" ${advanced ? "hidden" : ""}>
                        <label>
                            Angle
                            <input class="appearance-gradient-angle" type="number" min="0" max="360" step="1" value="${angle}">
                            <span>deg</span>
                        </label>
                        <label>
                            Start
                            <input class="appearance-gradient-start" type="color" value="${startColorHex}">
                        </label>
                        <label>
                            End
                            <input class="appearance-gradient-end" type="color" value="${endColorHex}">
                        </label>
                    </div>
                    <div class="appearance-gradient-advanced-input" ${advanced ? "" : "hidden"}>
                        <input class="appearance-gradient-raw" type="text" value="${this.#escapeAttribute(currentValue)}" spellcheck="false">
                    </div>
                    <button type="button" class="appearance-row-reset" title="Reset to default">Reset</button>
                </div>
            </div>
        `;
    }

    #renderTypographySection(effective)
    {
        const optionsHtml = ThemeVariableRegistry.getFontFamilyOptions().map(option =>
        {
            const isSelected = option.value === effective.fontFamily;
            return `<option value="${this.#escapeAttribute(option.value)}" ${isSelected ? "selected" : ""}>${option.label}</option>`;
        }).join("");

        return `
            <section class="appearance-section" data-group="Typography">
                <h3 class="appearance-section-title">Typography</h3>
                <div class="appearance-section-rows">
                    <div class="appearance-row" data-type="font-family">
                        <span class="appearance-row-label">Font Family</span>
                        <div class="appearance-row-controls">
                            <select class="appearance-font-select">${optionsHtml}</select>
                            <button type="button" class="appearance-font-reset" title="Reset to default">Reset</button>
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    #renderZoomSection(effective)
    {
        const zoomValue = effective.zoom;
        return `
            <section class="appearance-section" data-group="Zoom">
                <h3 class="appearance-section-title">Zoom</h3>
                <div class="appearance-section-rows">
                    <div class="appearance-row" data-type="zoom">
                        <span class="appearance-row-label">Page Zoom</span>
                        <div class="appearance-row-controls appearance-zoom-controls">
                            <input class="appearance-zoom-slider" type="range"
                                min="${ThemeVariableRegistry.MINIMUM_ZOOM}"
                                max="${ThemeVariableRegistry.MAXIMUM_ZOOM}"
                                step="${ThemeVariableRegistry.ZOOM_STEP}"
                                value="${zoomValue}">
                            <input class="appearance-zoom-number" type="number"
                                min="${ThemeVariableRegistry.MINIMUM_ZOOM}"
                                max="${ThemeVariableRegistry.MAXIMUM_ZOOM}"
                                step="${ThemeVariableRegistry.ZOOM_STEP}"
                                value="${zoomValue}">
                            <button type="button" class="appearance-zoom-reset" title="Reset to default">Reset</button>
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    #bindEventHandlers()
    {
        this.querySelectorAll(".appearance-row[data-type='color']").forEach(row => this.#bindColorRow(row));
        this.querySelectorAll(".appearance-row[data-type='length'], .appearance-row[data-type='text']").forEach(row => this.#bindTextRow(row));
        this.querySelectorAll(".appearance-row[data-type='gradient']").forEach(row => this.#bindGradientRow(row));

        const fontSelect = this.querySelector(".appearance-font-select");
        if (fontSelect)
        {
            fontSelect.addEventListener("change", () =>
            {
                AppearanceManager.update({ fontFamily: fontSelect.value });
            });
        }

        const fontReset = this.querySelector(".appearance-font-reset");
        if (fontReset)
        {
            fontReset.addEventListener("click", () =>
            {
                AppearanceManager.update({ fontFamily: null });
            });
        }

        const zoomSlider = this.querySelector(".appearance-zoom-slider");
        const zoomNumber = this.querySelector(".appearance-zoom-number");
        const zoomReset = this.querySelector(".appearance-zoom-reset");
        if (zoomSlider && zoomNumber)
        {
            zoomSlider.addEventListener("input", () =>
            {
                const value = Number(zoomSlider.value);
                zoomNumber.value = String(value);
                AppearanceManager.update({ zoom: value });
            });
            zoomNumber.addEventListener("change", () =>
            {
                let value = Number(zoomNumber.value);
                if (!isFinite(value))
                {
                    value = ThemeVariableRegistry.DEFAULT_ZOOM;
                }
                value = Math.max(ThemeVariableRegistry.MINIMUM_ZOOM, Math.min(ThemeVariableRegistry.MAXIMUM_ZOOM, value));
                zoomNumber.value = String(value);
                zoomSlider.value = String(value);
                AppearanceManager.update({ zoom: value });
            });
        }
        if (zoomReset)
        {
            zoomReset.addEventListener("click", () =>
            {
                AppearanceManager.update({ zoom: null });
            });
        }

        const resetAllButton = this.querySelector(".appearance-reset-all-button");
        if (resetAllButton)
        {
            resetAllButton.addEventListener("click", () =>
            {
                AppearanceManager.resetAll();
                this.#advancedGradient = false;
                this.#render();
            });
        }
    }

    #bindColorRow(row)
    {
        const variableName = row.dataset.variable;
        const picker = row.querySelector(".appearance-color-picker");
        const textInput = row.querySelector(".appearance-color-text");
        const resetButton = row.querySelector(".appearance-row-reset");

        picker.addEventListener("input", () =>
        {
            textInput.value = picker.value;
            AppearanceManager.update({ cssVariables: { [variableName]: picker.value } });
        });

        textInput.addEventListener("change", () =>
        {
            const candidate = textInput.value.trim();
            if (!AppearanceSettingsPanel.#isValidCssColor(candidate))
            {
                textInput.value = AppearanceManager.getEffective().cssVariables[variableName];
                return;
            }
            picker.value = AppearanceSettingsPanel.#toHexForPicker(candidate);
            AppearanceManager.update({ cssVariables: { [variableName]: candidate } });
        });

        resetButton.addEventListener("click", () =>
        {
            AppearanceManager.resetVariable(variableName);
            const defaultValue = ThemeVariableRegistry.getDefault(variableName);
            textInput.value = defaultValue;
            picker.value = AppearanceSettingsPanel.#toHexForPicker(defaultValue);
        });
    }

    #bindTextRow(row)
    {
        const variableName = row.dataset.variable;
        const textInput = row.querySelector(".appearance-text-input");
        const resetButton = row.querySelector(".appearance-row-reset");

        textInput.addEventListener("change", () =>
        {
            AppearanceManager.update({ cssVariables: { [variableName]: textInput.value } });
        });

        resetButton.addEventListener("click", () =>
        {
            AppearanceManager.resetVariable(variableName);
            textInput.value = ThemeVariableRegistry.getDefault(variableName);
        });
    }

    #bindGradientRow(row)
    {
        const variableName = row.dataset.variable;
        const advancedToggle = row.querySelector(".appearance-gradient-advanced-toggle");
        const decomposedContainer = row.querySelector(".appearance-gradient-decomposed");
        const advancedContainer = row.querySelector(".appearance-gradient-advanced-input");
        const angleInput = row.querySelector(".appearance-gradient-angle");
        const startInput = row.querySelector(".appearance-gradient-start");
        const endInput = row.querySelector(".appearance-gradient-end");
        const rawInput = row.querySelector(".appearance-gradient-raw");
        const preview = row.querySelector(".appearance-gradient-preview");
        const resetButton = row.querySelector(".appearance-row-reset");

        const commitFromDecomposed = () =>
        {
            const angle = Number(angleInput.value);
            const value = `linear-gradient(${isFinite(angle) ? angle : 45}deg, ${startInput.value}, ${endInput.value})`;
            preview.style.background = value;
            rawInput.value = value;
            AppearanceManager.update({ cssVariables: { [variableName]: value } });
        };

        advancedToggle.addEventListener("change", () =>
        {
            this.#advancedGradient = advancedToggle.checked;
            decomposedContainer.hidden = advancedToggle.checked;
            advancedContainer.hidden = !advancedToggle.checked;
            row.dataset.advanced = advancedToggle.checked ? "1" : "0";
        });

        angleInput.addEventListener("input", commitFromDecomposed);
        startInput.addEventListener("input", commitFromDecomposed);
        endInput.addEventListener("input", commitFromDecomposed);

        rawInput.addEventListener("change", () =>
        {
            const candidate = rawInput.value.trim();
            preview.style.background = candidate;
            AppearanceManager.update({ cssVariables: { [variableName]: candidate } });
        });

        resetButton.addEventListener("click", () =>
        {
            const defaultValue = ThemeVariableRegistry.getDefault(variableName);
            AppearanceManager.resetVariable(variableName);
            preview.style.background = defaultValue;
            rawInput.value = defaultValue;
            const decomposed = AppearanceSettingsPanel.#decomposeGradient(defaultValue);
            if (decomposed)
            {
                angleInput.value = String(decomposed.angle);
                startInput.value = AppearanceSettingsPanel.#toHexForPicker(decomposed.startColor);
                endInput.value = AppearanceSettingsPanel.#toHexForPicker(decomposed.endColor);
            }
        });
    }

    #refreshControls()
    {
        const effective = AppearanceManager.getEffective();

        this.querySelectorAll(".appearance-row[data-type='color']").forEach(row =>
        {
            const variableName = row.dataset.variable;
            const value = effective.cssVariables[variableName];
            const picker = row.querySelector(".appearance-color-picker");
            const text = row.querySelector(".appearance-color-text");
            if (picker)
            {
                picker.value = AppearanceSettingsPanel.#toHexForPicker(value);
            }
            if (text && text !== document.activeElement)
            {
                text.value = value;
            }
        });

        this.querySelectorAll(".appearance-row[data-type='length'], .appearance-row[data-type='text']").forEach(row =>
        {
            const variableName = row.dataset.variable;
            const text = row.querySelector(".appearance-text-input");
            if (text && text !== document.activeElement)
            {
                text.value = effective.cssVariables[variableName];
            }
        });

        const gradientRow = this.querySelector(".appearance-row[data-type='gradient']");
        if (gradientRow)
        {
            const variableName = gradientRow.dataset.variable;
            const value = effective.cssVariables[variableName];
            const preview = gradientRow.querySelector(".appearance-gradient-preview");
            if (preview)
            {
                preview.style.background = value;
            }
            const rawInput = gradientRow.querySelector(".appearance-gradient-raw");
            if (rawInput && rawInput !== document.activeElement)
            {
                rawInput.value = value;
            }
            const decomposed = AppearanceSettingsPanel.#decomposeGradient(value);
            if (decomposed)
            {
                const angleInput = gradientRow.querySelector(".appearance-gradient-angle");
                const startInput = gradientRow.querySelector(".appearance-gradient-start");
                const endInput = gradientRow.querySelector(".appearance-gradient-end");
                if (angleInput && angleInput !== document.activeElement)
                {
                    angleInput.value = String(decomposed.angle);
                }
                if (startInput && startInput !== document.activeElement)
                {
                    startInput.value = AppearanceSettingsPanel.#toHexForPicker(decomposed.startColor);
                }
                if (endInput && endInput !== document.activeElement)
                {
                    endInput.value = AppearanceSettingsPanel.#toHexForPicker(decomposed.endColor);
                }
            }
        }

        const fontSelect = this.querySelector(".appearance-font-select");
        if (fontSelect && fontSelect !== document.activeElement)
        {
            fontSelect.value = effective.fontFamily;
        }

        const zoomSlider = this.querySelector(".appearance-zoom-slider");
        const zoomNumber = this.querySelector(".appearance-zoom-number");
        if (zoomSlider && zoomSlider !== document.activeElement)
        {
            zoomSlider.value = String(effective.zoom);
        }
        if (zoomNumber && zoomNumber !== document.activeElement)
        {
            zoomNumber.value = String(effective.zoom);
        }
    }

    #escapeAttribute(value)
    {
        return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    static #canDecomposeGradient(value)
    {
        return AppearanceSettingsPanel.#decomposeGradient(value) !== null;
    }

    static #decomposeGradient(value)
    {
        if (typeof value !== "string")
        {
            return null;
        }
        const match = value.trim().match(/^linear-gradient\(\s*(-?\d+(?:\.\d+)?)\s*deg\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/i);
        if (!match)
        {
            return null;
        }
        return { angle: Number(match[1]), startColor: match[2].trim(), endColor: match[3].trim() };
    }

    static #isValidCssColor(value)
    {
        if (typeof value !== "string" || value.length === 0)
        {
            return false;
        }
        const probe = AppearanceSettingsPanel.COLOR_PROBE;
        if (!probe)
        {
            return true;
        }
        probe.style.color = "";
        probe.style.color = value;
        return probe.style.color !== "";
    }

    static #toHexForPicker(value)
    {
        if (typeof value !== "string")
        {
            return "#000000";
        }

        const trimmed = value.trim();
        const hexMatch = trimmed.match(/^#([0-9a-fA-F]{3,8})$/);
        if (hexMatch)
        {
            return AppearanceSettingsPanel.#normaliseHex(hexMatch[1]);
        }

        const probe = AppearanceSettingsPanel.COLOR_PROBE;
        if (!probe)
        {
            return "#000000";
        }
        probe.style.color = "";
        probe.style.color = trimmed;
        if (probe.style.color === "")
        {
            return "#000000";
        }

        if (!probe.isConnected)
        {
            document.body.appendChild(probe);
        }
        const computed = getComputedStyle(probe).color;
        const componentMatch = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!componentMatch)
        {
            return "#000000";
        }
        const redValue = Number(componentMatch[1]);
        const greenValue = Number(componentMatch[2]);
        const blueValue = Number(componentMatch[3]);
        return "#" + [redValue, greenValue, blueValue].map(channel => channel.toString(16).padStart(2, "0")).join("");
    }

    static #normaliseHex(hexBody)
    {
        if (hexBody.length === 3)
        {
            return "#" + hexBody.split("").map(character => character + character).join("").toLowerCase();
        }
        if (hexBody.length === 6)
        {
            return ("#" + hexBody).toLowerCase();
        }
        if (hexBody.length === 8)
        {
            return ("#" + hexBody.slice(0, 6)).toLowerCase();
        }
        return "#000000";
    }
}

customElements.define("appearance-settings-panel", AppearanceSettingsPanel);
export default AppearanceSettingsPanel;
