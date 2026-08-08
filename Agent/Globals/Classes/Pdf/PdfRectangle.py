class PdfRectangle:
    """
    An axis-aligned rectangle expressed in PDF canvas units (points, 1/72 inch).

    PDF — and therefore PDFium — places the coordinate origin at the BOTTOM-left
    of the page with the y axis growing upwards. Every raster consumer in this
    codebase (Pillow, the layout detector, the figure crop boxes persisted on
    figure documents) instead works in pixels from the TOP-left with y growing
    downwards.

    That flip is the single most dangerous part of reading a PDF, because
    getting it wrong produces no exception at all — figures are simply cropped
    from the mirrored part of the page. It is therefore confined to this one
    class, and nothing outside it is permitted to convert between the two
    coordinate spaces.
    """

    POINTS_PER_INCH = 72.0

    def __init__(self, left, bottom, right, top):
        self.__left = float(min(left, right))
        self.__bottom = float(min(bottom, top))
        self.__right = float(max(left, right))
        self.__top = float(max(bottom, top))

    def get_left(self):
        return self.__left

    def get_bottom(self):
        return self.__bottom

    def get_right(self):
        return self.__right

    def get_top(self):
        return self.__top

    def get_width(self):
        return self.__right - self.__left

    def get_height(self):
        return self.__top - self.__bottom

    def to_pixel_box(self, page_height_in_points, render_dpi):
        """
        Converts this bottom-left-origin rectangle into a top-left-origin pixel
        box of the form (x0, y0, x1, y1), matching what Pillow and the layout
        detector expect for a page rasterized at render_dpi.
        """
        scale = render_dpi / PdfRectangle.POINTS_PER_INCH
        pixel_x0 = int(self.__left * scale)
        pixel_x1 = int(self.__right * scale)
        # The y axis inverts here: a high PDF y (near the page top) has to become
        # a small pixel y, so the rectangle's TOP edge yields the pixel box's y0.
        pixel_y0 = int((page_height_in_points - self.__top) * scale)
        pixel_y1 = int((page_height_in_points - self.__bottom) * scale)
        return (pixel_x0, pixel_y0, pixel_x1, pixel_y1)

    @staticmethod
    def from_pixel_box(pixel_box, page_height_in_points, render_dpi):
        """
        Inverse of to_pixel_box — turns a top-left-origin pixel box back into a
        bottom-left-origin rectangle in PDF canvas units.
        """
        scale = PdfRectangle.POINTS_PER_INCH / render_dpi
        pixel_x0, pixel_y0, pixel_x1, pixel_y1 = pixel_box
        left = pixel_x0 * scale
        right = pixel_x1 * scale
        top = page_height_in_points - (pixel_y0 * scale)
        bottom = page_height_in_points - (pixel_y1 * scale)
        return PdfRectangle(left, bottom, right, top)

    def __repr__(self):
        return (
            f"PdfRectangle(left={self.__left:.2f}, bottom={self.__bottom:.2f}, "
            f"right={self.__right:.2f}, top={self.__top:.2f})"
        )
