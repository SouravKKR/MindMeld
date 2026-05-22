from typing import List

from pydantic import BaseModel, Field


class DiagramGroup(BaseModel):
    """A container / grouping frame that visually encloses one or more nodes."""

    id: str = Field(
        description = "Unique lowercase ID for this container."
    )

    label: str = Field(
        description = (
            "Text label that names this container. Empty string if the container has "
            "no label."
        )
    )

    contained_node_ids: List[str] = Field(
        description = "IDs of all DiagramNode entries that visually fall inside this container."
    )

    border_style: str = Field(
        description = "Border line style: 'dashed' or 'solid'."
    )

    x_percent: float = Field(
        description = "Horizontal position of the container's top-left corner (0.0 to 100.0)."
    )

    y_percent: float = Field(
        description = "Vertical position of the container's top-left corner (0.0 to 100.0)."
    )

    width_percent: float = Field(
        description = "Container width as percent of canvas (0.0 to 100.0)."
    )

    height_percent: float = Field(
        description = "Container height as percent of canvas (0.0 to 100.0)."
    )
