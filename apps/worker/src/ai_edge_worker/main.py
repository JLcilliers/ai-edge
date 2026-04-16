"""AI Edge worker entrypoint.

Phase 0: skeleton only. LangGraph graphs land in Phase 1 and after:

    Phase 1:   graphs/audit.py         — Trust Alignment multi-model consensus
               graphs/visibility.py    — Citation + source-origin mapping
    Phase 2:   graphs/reddit.py        — PRAW + sentiment classifier
               graphs/aio_capture.py   — DataForSEO primary, Playwright fallback
    Phase 3:   graphs/suppression.py   — Crawl + embed + distance + remediation
               graphs/entity.py        — Schema + third-party NAP parity
    Phase 4:   graphs/competitive.py   — Share-of-voice + praise asymmetry
    Post-v1:   graphs/scenario_lab.py  — PSO-calibrated ranker simulator
"""
from __future__ import annotations

import logging

from ai_edge_worker import __version__

log = logging.getLogger("ai_edge_worker")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("ai-edge-worker v%s — Phase 0 skeleton; no graphs registered yet", __version__)


if __name__ == "__main__":
    main()
