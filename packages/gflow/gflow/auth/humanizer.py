"""
Human-like browser interaction via Chrome DevTools Protocol (CDP).

Adapted from a Playwright-based humanizer to work over raw CDP WebSocket.
Provides Bezier-curved mouse movement, gradual scrolling with reading pace,
and realistic timing — all via Input.dispatchMouseEvent / Input.dispatchKeyEvent.

reCAPTCHA Enterprise v3 tracks real DOM-level input events, not just JS
dispatched events.  CDP Input.dispatch* fires at the browser engine level,
identical to actual hardware input, so reCAPTCHA scores them highly.
"""

from __future__ import annotations

import math
import random
import time
import logging
from typing import Tuple, List, Optional, Callable

logger = logging.getLogger("gflow.humanizer")

# ── Types ──
Point = Tuple[float, float]


# ═══════════════════════════════════════════════════════════════════
#  Timing — session state machine + calibrated delay distributions
# ═══════════════════════════════════════════════════════════════════

class HumanTiming:
    """Delay distributions calibrated against real human interaction data."""

    def __init__(self, speed_multiplier: float = 1.0):
        self.speed_multiplier = speed_multiplier

    def _scale(self, ms: float) -> float:
        return max(10, ms * self.speed_multiplier)

    def _gaussian(self, mean: float, stddev: float, min_val: float = 0) -> float:
        return max(min_val, random.gauss(mean, stddev))

    # ── Specific delay types (return seconds) ──

    def pre_click_delay(self) -> float:
        return self._scale(self._gaussian(120, 40, 50)) / 1000

    def click_hold_duration(self) -> float:
        return self._scale(self._gaussian(80, 20, 40)) / 1000

    def post_click_delay(self) -> float:
        return self._scale(self._gaussian(200, 80, 80)) / 1000

    def between_actions_delay(self) -> float:
        return self._scale(self._gaussian(400, 150, 150)) / 1000

    def scroll_tick_delay(self) -> float:
        return self._scale(self._gaussian(55, 15, 20)) / 1000

    def scroll_reading_pause(self) -> float:
        return self._scale(self._gaussian(1200, 400, 300)) / 1000


# ═══════════════════════════════════════════════════════════════════
#  Bezier math — same algorithms as the Playwright humanizer
# ═══════════════════════════════════════════════════════════════════

def _bezier_point(t: float, points: List[Point]) -> Point:
    """De Casteljau evaluation of an arbitrary-degree Bezier curve."""
    pts = list(points)
    n = len(pts)
    for r in range(1, n):
        for i in range(n - r):
            pts[i] = (
                (1 - t) * pts[i][0] + t * pts[i + 1][0],
                (1 - t) * pts[i][1] + t * pts[i + 1][1],
            )
    return pts[0]


def _distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _fitts_time(distance: float, target_width: float = 50) -> float:
    """Fitts's Law: movement time in ms."""
    a, b = 50, 150
    w = max(target_width, 1)
    return a + b * math.log2(distance / w + 1)


def _generate_control_points(start: Point, end: Point, num_points: int = 2) -> List[Point]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    dist = math.hypot(dx, dy)
    angle = math.atan2(dy, dx)
    spread = dist * random.uniform(0.15, 0.4)

    controls = []
    for i in range(num_points):
        t = (i + 1) / (num_points + 1) + random.uniform(-0.1, 0.1)
        t = max(0.1, min(0.9, t))
        offset = random.gauss(0, spread * 0.4)
        cx = start[0] + dx * t + math.cos(angle + math.pi / 2) * offset
        cy = start[1] + dy * t + math.sin(angle + math.pi / 2) * offset
        controls.append((cx, cy))
    return controls


def _generate_path(start: Point, end: Point, steps: int = 50) -> List[Point]:
    num_controls = random.choice([2, 2, 3])
    controls = _generate_control_points(start, end, num_controls)
    all_points = [start] + controls + [end]
    return [_bezier_point(i / steps, all_points) for i in range(steps + 1)]


def _add_jitter(path: List[Point], intensity: float = 1.2) -> List[Point]:
    jittered = []
    for i, (x, y) in enumerate(path):
        edge_factor = 0.3 if (i < 5 or i > len(path) - 5) else 1.0
        jx = x + random.gauss(0, intensity * edge_factor)
        jy = y + random.gauss(0, intensity * edge_factor)
        jittered.append((jx, jy))
    jittered[0] = path[0]
    jittered[-1] = path[-1]
    return jittered


def _generate_step_delays(num_steps: int, total_time_ms: float) -> List[float]:
    """Sine-based easing: slow at start/end, fast in middle."""
    raw = [math.sin(math.pi * i / num_steps) + 0.3 for i in range(num_steps)]
    total_raw = sum(raw)
    delays = [(r / total_raw) * total_time_ms for r in raw]
    return [max(3, d + random.gauss(0, d * 0.15)) for d in delays]


# ═══════════════════════════════════════════════════════════════════
#  CDP Humanizer — ties math to actual CDP Input.dispatch* commands
# ═══════════════════════════════════════════════════════════════════

class CDPHumanizer:
    """
    Human-like mouse/scroll controller that sends real input events
    through Chrome DevTools Protocol.

    Usage:
        humanizer = CDPHumanizer(cdp_send_fn)
        humanizer.move_mouse(500, 300)
        humanizer.click(500, 300)
        humanizer.scroll_down(400)
        humanizer.full_warmup()   # Run a complete warm-up sequence
    """

    def __init__(self, cdp_send: Callable, timing: Optional[HumanTiming] = None):
        """
        Args:
            cdp_send: Function that sends CDP commands. Signature:
                      cdp_send(method: str, params: dict) -> dict
            timing: HumanTiming instance (created with defaults if None)
        """
        self._cdp = cdp_send
        self.timing = timing or HumanTiming()
        # Start mouse at a random realistic position
        self.mouse_x = random.uniform(300, 700)
        self.mouse_y = random.uniform(200, 400)

    # ── Low-level CDP dispatchers ──

    def _dispatch_mouse(self, event_type: str, x: float, y: float,
                        button: str = "none", click_count: int = 0) -> None:
        """Send Input.dispatchMouseEvent via CDP."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": event_type,
            "x": round(x, 2),
            "y": round(y, 2),
            "button": button,
            "clickCount": click_count,
            "timestamp": time.time(),
        })

    def _dispatch_mouse_wheel(self, x: float, y: float,
                              delta_x: float = 0, delta_y: float = 0) -> None:
        """Send a mouse wheel event via CDP."""
        self._cdp("Input.dispatchMouseEvent", {
            "type": "mouseWheel",
            "x": round(x, 2),
            "y": round(y, 2),
            "deltaX": round(delta_x),
            "deltaY": round(delta_y),
            "timestamp": time.time(),
        })

    # ── Mouse movement ──

    def move_mouse(self, target_x: float, target_y: float,
                   target_width: float = 50) -> None:
        """
        Move mouse to (target_x, target_y) along a Bezier curve
        with Fitts's Law timing and micro-jitter.
        """
        start = (self.mouse_x, self.mouse_y)
        end = (target_x, target_y)
        dist = _distance(start, end)

        if dist < 2:
            return  # Already there

        # Calculate movement time via Fitts's Law
        total_time_ms = _fitts_time(dist, target_width) * self.timing.speed_multiplier

        # More steps for longer distances
        steps = max(15, min(80, int(dist / 8)))

        # Generate curved path with jitter
        path = _generate_path(start, end, steps)
        path = _add_jitter(path, intensity=random.uniform(0.8, 1.5))

        # Generate per-step timing (slow-fast-slow)
        delays = _generate_step_delays(len(path) - 1, total_time_ms)

        # Execute movement
        for i in range(1, len(path)):
            px, py = path[i]
            self._dispatch_mouse("mouseMoved", px, py)
            time.sleep(delays[i - 1] / 1000)

        self.mouse_x = target_x
        self.mouse_y = target_y

    def click(self, x: float, y: float, target_width: float = 50) -> None:
        """Move to position and click with human timing."""
        self.move_mouse(x, y, target_width)

        # Overshoot and correct (~20% chance)
        if random.random() < 0.20:
            overshoot_dist = random.uniform(5, 15)
            angle = random.uniform(0, 2 * math.pi)
            ox = x + math.cos(angle) * overshoot_dist
            oy = y + math.sin(angle) * overshoot_dist

            self._dispatch_mouse("mouseMoved", ox, oy)
            time.sleep(random.uniform(0.05, 0.12))

            # Correct back
            correction_path = _generate_path((ox, oy), (x, y), random.randint(5, 10))
            for px, py in correction_path[1:]:
                self._dispatch_mouse("mouseMoved", px, py)
                time.sleep(random.uniform(0.005, 0.015))

        # Pre-click pause
        time.sleep(self.timing.pre_click_delay())

        # Mouse down
        self._dispatch_mouse("mousePressed", x, y, button="left", click_count=1)
        time.sleep(self.timing.click_hold_duration())

        # Mouse up
        self._dispatch_mouse("mouseReleased", x, y, button="left", click_count=1)

        # Post-click wait
        time.sleep(self.timing.post_click_delay())

        self.mouse_x = x
        self.mouse_y = y

    # ── Scrolling ──

    def scroll_down(self, pixels: int) -> None:
        """Scroll down gradually in bursts, like a real human."""
        scrolled = 0
        target = pixels + random.randint(-30, 30)
        mx = self.mouse_x
        my = self.mouse_y

        while scrolled < target:
            tick_amount = random.randint(50, 150)
            tick_amount = min(tick_amount, target - scrolled + random.randint(0, 30))

            burst_ticks = random.randint(2, 5)
            for _ in range(burst_ticks):
                if scrolled >= target:
                    break
                self._dispatch_mouse_wheel(mx, my, delta_y=tick_amount)
                scrolled += tick_amount
                time.sleep(self.timing.scroll_tick_delay())

            # Reading pause ~30% of the time
            if random.random() < 0.30:
                time.sleep(self.timing.scroll_reading_pause())
            else:
                time.sleep(random.uniform(0.1, 0.4) * self.timing.speed_multiplier)

        # Overshoot and correct (~25% chance)
        if random.random() < 0.25:
            overshoot = random.randint(50, 150)
            self._dispatch_mouse_wheel(mx, my, delta_y=overshoot)
            time.sleep(random.uniform(0.2, 0.5))
            # Scroll back
            ticks = random.randint(2, 3)
            per_tick = overshoot // ticks
            for _ in range(ticks):
                self._dispatch_mouse_wheel(mx, my, delta_y=-per_tick)
                time.sleep(self.timing.scroll_tick_delay())

    def scroll_up(self, pixels: int) -> None:
        """Scroll up gradually."""
        scrolled = 0
        target = pixels + random.randint(-20, 20)
        mx = self.mouse_x
        my = self.mouse_y

        while scrolled < target:
            tick_amount = random.randint(50, 120)
            tick_amount = min(tick_amount, target - scrolled + random.randint(0, 20))

            burst_ticks = random.randint(2, 4)
            for _ in range(burst_ticks):
                if scrolled >= target:
                    break
                self._dispatch_mouse_wheel(mx, my, delta_y=-tick_amount)
                scrolled += tick_amount
                time.sleep(self.timing.scroll_tick_delay())

            if random.random() < 0.25:
                time.sleep(self.timing.scroll_reading_pause())
            else:
                time.sleep(random.uniform(0.1, 0.3) * self.timing.speed_multiplier)

    # ── Idle fidgeting ──

    def idle_movement(self, duration: float = 3.0) -> None:
        """Small random mouse movements simulating fidgeting while reading."""
        end_time = time.time() + duration
        while time.time() < end_time:
            dx = random.gauss(0, 40)
            dy = random.gauss(0, 30)
            target_x = max(50, min(1400, self.mouse_x + dx))
            target_y = max(50, min(800, self.mouse_y + dy))

            # Small movement (fewer steps for idle)
            path = _generate_path(
                (self.mouse_x, self.mouse_y),
                (target_x, target_y),
                random.randint(5, 12),
            )
            for px, py in path[1:]:
                self._dispatch_mouse("mouseMoved", px, py)
                time.sleep(random.uniform(0.01, 0.03))

            self.mouse_x = target_x
            self.mouse_y = target_y
            time.sleep(random.uniform(0.8, 2.5))

    # ── Full warm-up sequence ──

    def full_warmup(self, duration: float = 12.0) -> None:
        """
        Run a complete warm-up that convincingly mimics a real user
        browsing the Flow page for several seconds.

        Sequence:
        1. Idle mouse movements (user landed on page, looking around)
        2. Scroll down to explore content
        3. Move mouse to various page elements
        4. Click on something benign
        5. Scroll back up
        6. More idle movement

        This builds enough behavioral signal for reCAPTCHA to assign
        a good trust score.
        """
        logger.info("Running human-like warm-up (%ds)...", int(duration))
        start = time.time()

        # Phase 1: Initial idle — user just loaded the page, eyes scanning
        self.idle_movement(duration=min(2.5, duration * 0.2))

        if time.time() - start > duration:
            return

        # Phase 2: Scroll down to explore
        self.scroll_down(random.randint(200, 500))
        time.sleep(random.uniform(0.5, 1.5))

        if time.time() - start > duration:
            return

        # Phase 3: Move mouse to a few random positions (reading content)
        for _ in range(random.randint(3, 5)):
            target_x = random.uniform(200, 900)
            target_y = random.uniform(150, 600)
            self.move_mouse(target_x, target_y)
            time.sleep(random.uniform(0.3, 1.0))
            if time.time() - start > duration:
                return

        # Phase 4: Click somewhere benign (body area, not a link)
        click_x = random.uniform(400, 800)
        click_y = random.uniform(300, 500)
        self.click(click_x, click_y)

        if time.time() - start > duration:
            return

        # Phase 5: Scroll back up
        self.scroll_up(random.randint(100, 300))
        time.sleep(random.uniform(0.3, 0.8))

        if time.time() - start > duration:
            return

        # Phase 6: More idle movement
        remaining = max(0.5, duration - (time.time() - start))
        self.idle_movement(duration=min(remaining, 3.0))

        elapsed = time.time() - start
        logger.info("Human warm-up complete (%.1fs)", elapsed)
