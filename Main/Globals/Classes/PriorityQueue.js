class PriorityQueue
{
    #heap = [];

    static left(index)
    {
        return 2 * index + 1;
    }

    static right(index)
    {
        return 2 * index + 2;
    }

    static parent(index)
    {
        return Math.floor((index - 1) / 2);
    }

    constructor(elements = [], key = (a, b) => a - b)
    {
        this.#heap = [];
        this.compare = key;

        if (elements.length > 0)
        {
            this.#heap = elements.slice();
            this.#buildHeap();
        }
    }
    
    size()
    {
        return this.#heap.length;
    }

    isEmpty()
    {
        return this.#heap.length === 0;
    }

    peek()
    {
        return this.#heap.length === 0 ? null : this.#heap[0];
    }

    push(value)
    {
        this.#heap.push(value);
        this.#heapifyUp(this.#heap.length - 1);
    }

    pop()
    {
        if (this.isEmpty())
        {
            return null;
        }

        if (this.#heap.length === 1)
        {
            return this.#heap.pop();
        }

        const root = this.#heap[0];
        this.#heap[0] = this.#heap.pop();
        this.#heapifyDown(0);

        return root;
    }  

    #buildHeap()
    {
        for (let i = PriorityQueue.parent(this.#heap.length - 1); i >= 0; i--)
        {
            this.#heapifyDown(i);
        }
    }

    #heapifyUp(index)
    {
        let current = index;

        while (current > 0)
        {
            const parent = PriorityQueue.parent(current);

            if (this.compare(this.#heap[current], this.#heap[parent]) < 0)
            {
                this.#swap(current, parent);
                current = parent;
            }
            else
            {
                break;
            }
        }
    }  
    #heapifyDown(index)
    {
        let smallest = index;

        while (true)
        {
            const left = PriorityQueue.left(smallest);
            const right = PriorityQueue.right(smallest);
            let candidate = smallest;

            if (left < this.#heap.length && this.compare(this.#heap[left], this.#heap[candidate]) < 0)
            {
                candidate = left;
            }

            if (right < this.#heap.length && this.compare(this.#heap[right], this.#heap[candidate]) < 0)
            {
                candidate = right;
            }

            if (candidate !== smallest)
            {
                this.#swap(smallest, candidate);
                smallest = candidate;
            }
            else
            {
                break;
            }
        }
    }

    #swap(i, j)
    {
        const temp = this.#heap[i];
        this.#heap[i] = this.#heap[j];
        this.#heap[j] = temp;
    }
}

export default PriorityQueue;