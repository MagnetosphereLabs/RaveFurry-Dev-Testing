"""Bounded, pre-Django admission for excessive traffic, including unknown paths."""
from collections import OrderedDict
import threading
import time

# (sustained requests/second, burst). These include shared NATs and multiple tabs.
# Polling/rendering have independent budgets from user actions and static assets.
BUDGETS = {
    "asset": (100, 800), "visualizer": (120, 360), "read": (80, 320),
    "action": (12, 80), "search": (5, 24), "submission": (1, 16),
    "login": (1, 24),
}
GLOBAL = {"asset": (2000, 4000), "visualizer": (1000, 2000),
          "read": (1000, 2000), "action": (160, 400), "search": (20, 40),
          "submission": (12, 36), "login": (40, 80)}


def workload(path, method):
    if path.startswith(("/static/", "/song-artwork/")) or path == "/favicon.ico":
        return "asset"
    if path == "/visualizer/features.json":
        return "visualizer"
    if path == "/api/musiq/search/":
        return "search"
    if path.endswith("request-music/"):
        return "submission"
    if method == "POST" and path in {"/moderator-login/", "/accounts/login/", "/admin/login/"}:
        return "login"
    return "read" if method in {"GET", "HEAD", "OPTIONS"} else "action"


class TrafficLimits:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.clients = OrderedDict()
        self.global_buckets = {}

    @staticmethod
    def _refill(bucket, now, budget):
        rate, burst = budget
        tokens, at = bucket if bucket else (burst, now)
        return min(burst, tokens + max(0, now - at) * rate)

    def check(self, client, group):
        now = self.clock()
        with self.lock:
            key = (client, group)
            local = self._refill(self.clients.pop(key, None), now, BUDGETS[group])
            shared = self._refill(self.global_buckets.get(group), now, GLOBAL[group])
            allowed = local >= 1 and shared >= 1
            self.clients[key] = (max(0, local - 1) if allowed else local, now)
            self.global_buckets[group] = (max(0, shared - 1) if allowed else shared, now)
            while len(self.clients) > 16384:
                self.clients.popitem(last=False)
            return 'ok' if allowed else 'client' if local < 1 else 'busy'

    def allow(self, client, group):
        return self.check(client, group) == 'ok'
