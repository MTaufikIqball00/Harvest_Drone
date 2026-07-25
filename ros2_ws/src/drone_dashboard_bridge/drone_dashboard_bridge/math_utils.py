import math
from typing import Any, Tuple, Optional

def quaternion_to_euler(q: Any) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Convert quaternion to euler angles (roll, pitch, yaw)."""
    if q is None:
        return None, None, None
    try:
        x = getattr(q, 'x', 0.0)
        y = getattr(q, 'y', 0.0)
        z = getattr(q, 'z', 0.0)
        w = getattr(q, 'w', 1.0)
        
        t0 = +2.0 * (w * x + y * z)
        t1 = +1.0 - 2.0 * (x * x + y * y)
        roll = math.atan2(t0, t1)
        
        t2 = +2.0 * (w * y - z * x)
        t2 = +1.0 if t2 > +1.0 else t2
        t2 = -1.0 if t2 < -1.0 else t2
        pitch = math.asin(t2)
        
        t3 = +2.0 * (w * z + x * y)
        t4 = +1.0 - 2.0 * (y * y + z * z)
        yaw = math.atan2(t3, t4)
        
        return roll, pitch, yaw
    except Exception:
        return None, None, None

def get_distance(x1: float, y1: float, x2: float, y2: float) -> float:
    return math.hypot(x2 - x1, y2 - y1)

def get_distance_squared(x1: float, y1: float, x2: float, y2: float) -> float:
    return (x2 - x1)**2 + (y2 - y1)**2

def clamp(val: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(val, max_val))
