from pydantic import BaseModel, Field


class DiagramSubjectRegion(BaseModel):

    top_percent: float = Field(
        description = (
            "Top edge of the diagram subject's bounding rectangle, as a percent of "
            "the SOURCE image's height (0.0 to 100.0). 0.0 means the very top of the "
            "source image."
        )
    )

    left_percent: float = Field(
        description = (
            "Left edge of the diagram subject's bounding rectangle, as a percent of "
            "the SOURCE image's width (0.0 to 100.0). 0.0 means the very left of the "
            "source image."
        )
    )

    bottom_percent: float = Field(
        description = (
            "Bottom edge of the diagram subject's bounding rectangle, as a percent of "
            "the SOURCE image's height (0.0 to 100.0). Must be strictly greater than "
            "top_percent."
        )
    )

    right_percent: float = Field(
        description = (
            "Right edge of the diagram subject's bounding rectangle, as a percent of "
            "the SOURCE image's width (0.0 to 100.0). Must be strictly greater than "
            "left_percent."
        )
    )
