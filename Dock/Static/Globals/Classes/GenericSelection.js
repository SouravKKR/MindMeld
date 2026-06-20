class GenericSelection
{
	#selection = [];
	#onSelectElement = (element)=>{};
	#onDeselectElement = (element)=>{};

	constructor(onSelectElement = (element)=>{}, onDeselectElement = (element)=>{})
	{
		this.#selection = [];
		this.#onSelectElement = onSelectElement;
		this.#onDeselectElement = onDeselectElement;
	}

	addSelection(selectionToAdd = [])
	{
		for(const element of selectionToAdd)
		{
			if(!this.#selection.includes(element))
			{
				this.#selection.push(element);
				this.#onSelectElement(element);
			}
		}
	}

	toggleSelection(selectionToToggle = [])
	{
		for(const element of selectionToToggle)
		{
			const index = this.#selection.indexOf(element);

			if(index === -1)
			{
				this.#selection.push(element);
				this.#onSelectElement(element);
			}
			else
			{
				this.#selection.splice(index,1);
				this.#onDeselectElement(element);
			}
		}
	}

	removeSelection(selectionToDeselect = [])
	{
		for(const element of selectionToDeselect)
		{
			const index = this.#selection.indexOf(element);

			if(index !== -1)
			{
				this.#selection.splice(index, 1);
				this.#onDeselectElement(element);
			}
		}
	}

	deselectAll()
	{
		this.#selection.forEach((element)=>{this.#onDeselectElement(element)});
		this.#selection.length = 0;
	}

	contains(element)
	{
		return this.#selection.includes(element);
	}

    getSelectedItems()
    {
        return this.#selection;
    }

	getSelectionCount()
	{
		return this.#selection.length;
	}

	getLastSelectedItem()
	{
		if(!this.#selection) return null;
		
		return this.#selection[this.#selection.length -1] ? this.#selection[this.#selection.length -1] : null;
	}
}

export default GenericSelection;