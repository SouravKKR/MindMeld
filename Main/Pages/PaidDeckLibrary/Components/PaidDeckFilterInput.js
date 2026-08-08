/**
 * PaidDeckFilterInput
 *
 * Abstract base for a single client-side filter input control. Each
 * subclass owns one filter type (text, number-range, date-range, etc.)
 * and renders its DOM under a host container. When the user changes the
 * input value, the subclass calls #emitChange() and the panel above it
 * relays the value into the search request.
 *
 * Subclasses MUST implement:
 *   - render(container) — build the DOM under `container`.
 *   - getValue() — return the current value in the shape the server
 *     filter expects (NumberRange returns { min, max }; MultiSelect
 *     returns an array; etc.).
 *   - clear() — reset internal state and re-render to defaults.
 *
 * Subclasses SHOULD implement setValue(value) if their filter can be
 * restored from a saved selection — showing a stored filter back to the
 * person who wrote it. A search box that starts empty every time needs
 * nothing; a saved permission rule that cannot show its own conditions
 * is unreadable and uneditable, so the types those rules use implement it.
 */
class PaidDeckFilterInput
{
    #metadata;
    #onChangeCallback;

    constructor(metadata, onChangeCallback)
    {
        if (!metadata || typeof metadata !== "object")
        {
            throw new Error("PaidDeckFilterInput requires metadata");
        }

        this.#metadata = metadata;
        this.#onChangeCallback = typeof onChangeCallback === "function" ? onChangeCallback : null;
    }

    getMetadata()
    {
        return this.#metadata;
    }

    getKey()
    {
        return this.#metadata.key;
    }

    getLabel()
    {
        return this.#metadata.label;
    }

    getType()
    {
        return this.#metadata.type;
    }

    emitChange()
    {
        if (this.#onChangeCallback !== null)
        {
            this.#onChangeCallback(this.getKey(), this.getValue());
        }
    }

    render(container)
    {
        throw new Error("PaidDeckFilterInput.render() must be implemented by subclass");
    }

    getValue()
    {
        throw new Error("PaidDeckFilterInput.getValue() must be implemented by subclass");
    }

    clear()
    {
        throw new Error("PaidDeckFilterInput.clear() must be implemented by subclass");
    }

    /**
     * Shows a previously saved value in this control. Called after render().
     *
     * A no-op by default rather than an error: a filter that cannot be restored
     * is a filter that simply starts empty, which is the correct behaviour for
     * a search box and never a reason to break the panel around it.
     *
     * @param {*} value in the same shape getValue() returns
     */
    setValue(value)
    {
    }
}

export default PaidDeckFilterInput;
