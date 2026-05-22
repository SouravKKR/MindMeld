from typing import Optional

from pydantic import BaseModel, Field


class DiagramConnection(BaseModel):

    from_node: str = Field(
        description = "Source node ID."
    )

    to_node: str = Field(
        description = "Target node ID."
    )

    connection_style: str = Field(
        description = (
            "Short snake_case identifier describing the visible style of this connector "
            "as drawn in the source (line weight, dashed vs solid, direction of "
            "arrowheads, etc.)."
        )
    )

    label: Optional[str] = Field(
        None,
        description = "Text written directly on the connector, if any."
    )
