/**
 * ThemeVariableRegistry
 *
 * Single source of truth describing every CSS variable that the
 * Appearance settings tab can customise. Hand-maintained to mirror
 * Main/CommonStyles/Theme.css exactly. When a new variable is added
 * to Theme.css, append a matching entry here.
 *
 * Each entry has:
 *   name          - CSS custom property name (with the leading "--")
 *   label         - human-readable label shown in the Appearance panel
 *   group         - sidebar/section grouping used by the panel
 *   type          - one of "color" | "gradient" | "length" | "text"
 *   defaultValue  - the value declared in Theme.css :root; also used by
 *                   AppearanceManager.revertAll() when reverting overrides
 */
class ThemeVariableRegistry
{
    static ENTRIES =
    [
        { name: "--primary-background-color",    label: "Primary Background",    group: "Backgrounds", type: "color",    defaultValue: "#1a1a1a" },
        { name: "--secondary-background-color",  label: "Secondary Background",  group: "Backgrounds", type: "color",    defaultValue: "#1f1f1f" },
        { name: "--tertiary-background-color",   label: "Tertiary Background",   group: "Backgrounds", type: "color",    defaultValue: "#2c2c2c" },
        { name: "--quaternary-background-color", label: "Quaternary Background", group: "Backgrounds", type: "color",    defaultValue: "#555555" },

        { name: "--primary-text-color",          label: "Primary Text",          group: "Text",        type: "color",    defaultValue: "#ffffff" },
        { name: "--secondary-text-color",        label: "Secondary Text",        group: "Text",        type: "color",    defaultValue: "#b8b8c4" },

        { name: "--primary-background-gradient", label: "Primary Gradient",      group: "Gradients",   type: "gradient", defaultValue: "linear-gradient(45deg, #0098C4, #B55BD0)" },

        { name: "--header-height",               label: "Header Height",         group: "Layout",      type: "length",   defaultValue: "60px" },

        { name: "--outline-color-subtle",        label: "Outline Subtle",        group: "Outlines",    type: "color",    defaultValue: "rgba(255, 255, 255, 0.08)" },
        { name: "--outline-color",               label: "Outline",               group: "Outlines",    type: "color",    defaultValue: "rgba(255, 255, 255, 0.14)" },
        { name: "--outline-color-strong",        label: "Outline Strong",        group: "Outlines",    type: "color",    defaultValue: "rgba(255, 255, 255, 0.32)" },

        { name: "--danger-background-color",     label: "Danger Background",     group: "Semantic",    type: "color",    defaultValue: "rgba(244, 67, 54, 0.15)" },
        { name: "--danger-text-color",           label: "Danger Text",           group: "Semantic",    type: "color",    defaultValue: "#f8a8a8" },
        { name: "--success-color",               label: "Success",               group: "Semantic",    type: "color",    defaultValue: "#4caf50" },
        { name: "--accent-color",                label: "Accent",                group: "Semantic",    type: "color",    defaultValue: "#2EB6E0" },
        { name: "--accent-color-hover",          label: "Accent Hover",          group: "Semantic",    type: "color",    defaultValue: "#5CCCEC" },
        { name: "--accent-background-color",     label: "Accent Background",     group: "Semantic",    type: "color",    defaultValue: "rgba(46, 182, 224, 0.18)" },

        { name: "--highlight-color",             label: "Highlight",             group: "Highlight",   type: "color",    defaultValue: "#F5B838" },
        { name: "--highlight-text-color",        label: "Highlight Text",        group: "Highlight",   type: "color",    defaultValue: "#1f1f23" },
        { name: "--highlight-background-soft",   label: "Highlight Background",  group: "Highlight",   type: "color",    defaultValue: "rgba(245, 184, 56, 0.18)" },

        { name: "--shadow-color",                label: "Shadow",                group: "Shadows",     type: "color",    defaultValue: "rgba(0, 0, 0, 0.2)" },
        { name: "--shadow-color-strong",         label: "Shadow Strong",         group: "Shadows",     type: "color",    defaultValue: "rgba(0, 0, 0, 0.4)" },

        { name: "--content-accent-color",            label: "Content Accent",            group: "Generated Content", type: "color",  defaultValue: "#00D2FF" },
        { name: "--content-muted-text-color",        label: "Content Muted Text",        group: "Generated Content", type: "color",  defaultValue: "rgba(255, 255, 255, 0.6)" },
        { name: "--content-attribution-text-color",  label: "Content Attribution Text",  group: "Generated Content", type: "color",  defaultValue: "rgba(255, 255, 255, 0.45)" },
        { name: "--content-callout-background-color", label: "Callout Background",       group: "Generated Content", type: "color",  defaultValue: "rgba(0, 0, 0, 0.15)" },
        { name: "--content-callout-border-color",    label: "Callout Border",            group: "Generated Content", type: "color",  defaultValue: "rgba(255, 255, 255, 0.25)" },
        { name: "--content-callout-border-radius",   label: "Callout Border Radius",     group: "Generated Content", type: "text",   defaultValue: "0 6px 6px 0" },
    ];

    static GROUP_ORDER =
    [
        "Backgrounds",
        "Text",
        "Gradients",
        "Layout",
        "Outlines",
        "Semantic",
        "Highlight",
        "Shadows",
        "Generated Content",
    ];

    static FONT_FAMILY_OPTIONS =
    [
        { value: "GoogleSans",          label: "Google Sans (default)" },
        { value: "system-ui",           label: "System UI" },
        { value: "Arial",               label: "Arial" },
        { value: "Helvetica",           label: "Helvetica" },
        { value: "\"Times New Roman\"", label: "Times New Roman" },
        { value: "Georgia",             label: "Georgia" },
        { value: "\"Courier New\"",     label: "Courier New" },
        { value: "Verdana",             label: "Verdana" },
        { value: "Tahoma",              label: "Tahoma" },
        { value: "monospace",           label: "Monospace" },
    ];

    static DEFAULT_FONT_FAMILY = "GoogleSans";
    static DEFAULT_ZOOM = 1.0;
    static MINIMUM_ZOOM = 0.5;
    static MAXIMUM_ZOOM = 2.0;
    static ZOOM_STEP = 0.05;

    static getAll()
    {
        return ThemeVariableRegistry.ENTRIES;
    }

    static getByGroup(groupName)
    {
        return ThemeVariableRegistry.ENTRIES.filter(entry => entry.group === groupName);
    }

    static getGroups()
    {
        return ThemeVariableRegistry.GROUP_ORDER;
    }

    static getDefault(variableName)
    {
        const entry = ThemeVariableRegistry.ENTRIES.find(candidate => candidate.name === variableName);
        return entry ? entry.defaultValue : null;
    }

    static getEntry(variableName)
    {
        return ThemeVariableRegistry.ENTRIES.find(candidate => candidate.name === variableName) ?? null;
    }

    static getFontFamilyOptions()
    {
        return ThemeVariableRegistry.FONT_FAMILY_OPTIONS;
    }
}

export default ThemeVariableRegistry;
