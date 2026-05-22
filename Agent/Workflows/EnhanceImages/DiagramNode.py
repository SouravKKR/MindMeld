from pydantic import BaseModel, Field


class DiagramNode(BaseModel):

    id: str = Field(
        description = "Unique lowercase ID for this node."
    )

    label: str = Field(
        description = (
            "The exact text bound to this node. If the node is a single box "
            "containing multiple lines of stacked text, join the lines with '\\n'."
        )
    )

    component_type: str = Field(
        description = (
            "Short snake_case identifier describing the visible shape of this node "
            "(e.g. the kind of shape, icon, or terminal text label it is). Use "
            "'text_only_label' for bare text that has arrows touching it but no "
            "surrounding shape."
        )
    )

    x_percent: float = Field(
        description = "Horizontal position of the node, as a percent of canvas width (0.0 to 100.0)."
    )

    y_percent: float = Field(
        description = "Vertical position of the node, as a percent of canvas height (0.0 to 100.0)."
    )
