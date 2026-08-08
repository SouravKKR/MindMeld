class LayoutDetection:
    """
    One region a layout model found on a rendered page.

    The role is a LayoutRegionRoles value rather than the model's own label
    string, so nothing downstream of the detector has to know which model
    produced it. The raw label is carried alongside for logging and for the
    offline tuning harness only — no production branch may switch on it.

    The pixel box is (x0, y0, x1, y1) with a TOP-LEFT origin, in pixels of the
    page raster at the render DPI it was detected on. That is the same space
    PdfDocumentReader.get_text_in_pixel_box and every crop in ImageExtractor
    work in.
    """

    def __init__(self, region_role, label, confidence_score, pixel_box):
        self.__region_role = region_role
        self.__label = label
        self.__confidence_score = float(confidence_score)
        self.__pixel_box = tuple(int(coordinate) for coordinate in pixel_box)

    def get_region_role(self):
        return self.__region_role

    def get_label(self):
        return self.__label

    def get_confidence_score(self):
        return self.__confidence_score

    def get_pixel_box(self):
        return self.__pixel_box

    def get_width(self):
        return self.__pixel_box[2] - self.__pixel_box[0]

    def get_height(self):
        return self.__pixel_box[3] - self.__pixel_box[1]

    def get_area(self):
        return max(0, self.get_width()) * max(0, self.get_height())

    def __repr__(self):
        return (
            f"LayoutDetection(role={self.__region_role.name}, label={self.__label!r}, "
            f"score={self.__confidence_score:.3f}, box={self.__pixel_box})"
        )
