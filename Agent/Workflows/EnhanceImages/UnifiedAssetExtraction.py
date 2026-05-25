from typing import List, Optional

from pydantic import BaseModel, Field

from Workflows.EnhanceImages.DiagramNode import DiagramNode
from Workflows.EnhanceImages.DiagramConnection import DiagramConnection
from Workflows.EnhanceImages.DiagramGroup import DiagramGroup
from Workflows.EnhanceImages.DiagramSubjectRegion import DiagramSubjectRegion


class UnifiedAssetExtraction(BaseModel):

    content_case: str = Field(
        description = (
            "Must be exactly one of two values: 'DIAGRAM' if the file contains ANY "
            "illustrative elements (charts, graphs, plots, diagrams, flowcharts, "
            "shapes), or 'TEXT_DATA' strictly if the file is pure text (code, logs, "
            "raw spreadsheet grids) with ZERO visual/illustrative components."
        )
    )

    # CASE A DATA CONTAINER ------------------------------------------------
    diagram_type: Optional[str] = Field(
        None,
        description = "High-level framework pattern."
    )

    core_topic: Optional[str] = Field(
        None,
        description = "The educational topic the figure illustrates."
    )

    caption: Optional[str] = Field(
        None,
        description = (
            "A clear, student-friendly caption summarizing what this figure illustrates."
        )
    )

    nodes: Optional[List[DiagramNode]] = Field(
        default = None,
        description = (
            "Every visible node in the diagram, including text-only labels that have "
            "arrows touching them."
        )
    )

    connections: Optional[List[DiagramConnection]] = Field(
        default = None,
        description = "Every visible arrow or line in the diagram."
    )

    groups: Optional[List[DiagramGroup]] = Field(
        default = None,
        description = (
            "Every visible container / grouping frame that encloses one or more nodes."
        )
    )

    diagram_subject_region_percent: Optional[DiagramSubjectRegion] = Field(
        default = None,
        description = (
            "The bounding rectangle that snugly encloses just the diagram subject "
            "(shapes, arrows, container frames, in-figure title), expressed as "
            "percentages of the SOURCE image. Excludes ambient body text, marginal "
            "text, page numbers, watermarks, and figure captions printed outside "
            "the figure border. Omit entirely (null) if the diagram already fills "
            "the source image edge-to-edge."
        )
    )

    # CASE B DATA CONTAINER ------------------------------------------------
    extracted_text_content: Optional[str] = Field(
        None,
        description = (
            "If content_case is 'TEXT_DATA', extract the raw source code text or data "
            "table here. Render tables out explicitly into a clean markdown data grid "
            "schema."
        )
    )
