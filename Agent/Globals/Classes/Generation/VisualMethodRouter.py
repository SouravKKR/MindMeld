from Globals.Enumerations.VisualKinds import VisualKinds
from Globals.Enumerations.VisualGenerationMethods import VisualGenerationMethods


class VisualMethodRouter:
    """
    Maps a declared visual KIND to the METHOD that produces it.

    This single mapping is the most consequential decision in the visual
    pipeline, so it lives in one pure, testable place rather than being spread
    through the generator as conditionals.

    Why symbolic beats raster for technical diagrams. Image models garble text
    and get geometry wrong in ways that look confident: a benzene ring with seven
    carbons, a ray diagram whose angles do not obey the law it illustrates, an
    axis label rendered as plausible-looking nonsense. SVG is code — labels are
    real text nodes, coordinates are exact, the output can be read, diffed and
    corrected. Students memorise visuals, so a wrong one is not a cosmetic defect;
    it is the deck teaching something false.

    Raster is therefore reserved for the one case where nothing has to be exact:
    a representational picture (a plant cell, a piece of apparatus) where the
    value is recognisability, not measurement.

    KaTeX and SMILES are separated out from general SVG because both have a
    canonical, unambiguous textual form that renders deterministically. Asking a
    model to draw a formula when it could emit the formula is strictly worse.
    """

    __METHOD_BY_KIND = {
        # Typeset directly — KaTeX is already bundled in the client.
        VisualKinds.EQUATION: VisualGenerationMethods.KATEX,

        # Canonical line notation, rendered by the client.
        VisualKinds.CHEMICAL_STRUCTURE: VisualGenerationMethods.SMILES,

        # Exact geometry, exact labels, exact quantities. Anything where a wrong
        # angle or a mislabelled axis makes the diagram teach the wrong thing.
        VisualKinds.RAY_DIAGRAM: VisualGenerationMethods.INLINE_SVG,
        VisualKinds.CIRCUIT_DIAGRAM: VisualGenerationMethods.INLINE_SVG,
        VisualKinds.FREE_BODY_DIAGRAM: VisualGenerationMethods.INLINE_SVG,
        VisualKinds.GRAPH: VisualGenerationMethods.INLINE_SVG,
        VisualKinds.GEOMETRIC_CONSTRUCTION: VisualGenerationMethods.INLINE_SVG,

        # Structural rather than geometric. Mermaid expresses these more reliably
        # than hand-placed SVG coordinates, and lays them out itself.
        VisualKinds.FLOW_OR_PROCESS: VisualGenerationMethods.MERMAID,
        VisualKinds.HIERARCHY_OR_TAXONOMY: VisualGenerationMethods.MERMAID,

        # Nothing needs to be numerically exact — recognisability is the whole
        # value. The one kind that routes to image generation.
        VisualKinds.ILLUSTRATIVE_OR_CONCEPTUAL: VisualGenerationMethods.RASTER_IMAGE,
    }

    # Methods whose output is markup rather than pixels. These share a generation
    # path, a validation path (parse + rasterize + vision review) and an
    # injection path (the markup goes into the HTML verbatim).
    __SYMBOLIC_METHODS = frozenset({
        VisualGenerationMethods.KATEX,
        VisualGenerationMethods.SMILES,
        VisualGenerationMethods.INLINE_SVG,
        VisualGenerationMethods.MERMAID,
    })

    @staticmethod
    def resolve_method(kind_name: str) -> VisualGenerationMethods:
        """
        Returns the generation method for a VisualKinds name.

        An unrecognised kind resolves to INLINE_SVG, not RASTER_IMAGE. That
        asymmetry is deliberate: the symbolic path is allowed to decline a
        diagram it cannot draw correctly and emit a labelled description instead,
        whereas image generation always returns a confident picture — including
        when it is wrong. When the routing information is untrustworthy, the
        route that can admit defeat is the safer default.
        """
        kind = VisualMethodRouter.__resolve_kind(kind_name)

        if kind is None:
            print(
                f"[VisualMethodRouter] Unrecognised visual kind '{kind_name}' — routing to INLINE_SVG, "
                f"which can degrade to a labelled description rather than guessing a picture."
            )
            return VisualGenerationMethods.INLINE_SVG

        return VisualMethodRouter.__METHOD_BY_KIND[kind]

    @staticmethod
    def __resolve_kind(kind_name: str):
        if not isinstance(kind_name, str):
            return None
        normalized_name = kind_name.strip().upper()
        return VisualKinds.__members__.get(normalized_name)

    @staticmethod
    def is_symbolic(method: VisualGenerationMethods) -> bool:
        return method in VisualMethodRouter.__SYMBOLIC_METHODS

    @staticmethod
    def requires_high_reasoning_effort(method: VisualGenerationMethods) -> bool:
        """
        Symbolic generation runs at high reasoning effort. This is the one place
        in the whole feature where spending extra reasoning is unambiguously
        worth it: a clunky or mislabelled diagram is worse than no diagram, and
        it is the failure students carry forward. Raster generation has its own
        thinking configuration on the image path and is not covered here.
        """
        return VisualMethodRouter.is_symbolic(method)
