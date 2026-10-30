from enum import Enum

class AnnotationKind(str, Enum):
    BOX2D = "box2d"
    MASK2D = "mask2d"
    MEASUREMENT = "measurement"
    POLYGON2D = "polygon2d"
    REGION3D = "region3d"
    TEXTSPAN = "textspan"
    TIMESPAN = "timespan"

    def __str__(self) -> str:
        return str(self.value)
