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
}

export default PaidDeckFilterInput;
