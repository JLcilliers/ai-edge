"""FastAPI entrypoint.

Phase 0: healthcheck only. Brand Truth CRUD + audit-run dispatch land in Phase 1
once Neon + Upstash credentials are provisioned.

Deployment target: Fly.io alongside the worker fleet (ADR-0005). Not Vercel
Functions — the API gateway co-locates with workers to minimize inter-service
latency and share the residential-proxy egress region.
"""
from __future__ import annotations

from fastapi import FastAPI

from ai_edge_api import __version__

app = FastAPI(title="AI Edge API", version=__version__)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
