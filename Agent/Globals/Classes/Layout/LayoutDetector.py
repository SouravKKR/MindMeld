class LayoutDetector:
    """
    The seam between ImageExtractor and whichever model finds regions on a page.

    Implementations return LayoutDetection objects whose role is already a
    LayoutRegionRoles value, so ImageExtractor never sees a model-specific label
    vocabulary and swapping the model is a constructor argument rather than an
    edit to the extraction pipeline.

    Implementations are responsible for everything model-specific: preprocessing,
    thresholding, mapping their own labels onto roles, clamping boxes to the page,
    and suppressing duplicate boxes. What reaches ImageExtractor must already be
    clean.
    """

    def detect(self, page_image, render_dpi):
        """
        Finds layout regions on one rendered page.

        page_image is an RGB Pillow image of the page rasterized at render_dpi.
        Returns a list of LayoutDetection, ordered most-confident first.
        """
        raise NotImplementedError("LayoutDetector subclasses must implement detect().")
