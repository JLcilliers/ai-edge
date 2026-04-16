"""Python mirror of packages/shared/src/brand-truth.ts (Zod).

Kept in manual sync per ADR-0004. Drift is caught by a parity test that
compares field names and required/default shapes against the exported
JSON Schema from the TypeScript side — to be added in Phase 0 week 2.
"""
from __future__ import annotations

from pydantic import BaseModel, Field, HttpUrl


class Geography(BaseModel):
    city: str
    state: str = Field(min_length=2, max_length=3)
    country: str = Field(default="US", min_length=2, max_length=2)
    radius_mi: int = Field(gt=0, le=500)


class Award(BaseModel):
    name: str
    year: int | None = Field(default=None, ge=1900, le=2100)
    source_url: HttpUrl


class ProviderBio(BaseModel):
    name: str
    credentials: list[str] = Field(default_factory=list)
    bio: str | None = None
    photo_url: HttpUrl | None = None
    bar_number: str | None = None
    license_number: str | None = None


class NotableCase(BaseModel):
    summary: str
    outcome: str | None = None
    jurisdiction: str | None = None
    source_url: HttpUrl | None = None


class BrandTruth(BaseModel):
    firm_name: str
    name_variants: list[str] = Field(default_factory=list)
    common_misspellings: list[str] = Field(default_factory=list)
    practice_areas: list[str] = Field(min_length=1)
    geographies_served: list[Geography] = Field(min_length=1)
    unique_differentiators: list[str] = Field(default_factory=list)
    required_positioning_phrases: list[str] = Field(default_factory=list)
    banned_claims: list[str] = Field(default_factory=list)
    attorney_bios: list[ProviderBio] = Field(default_factory=list)
    provider_bios: list[ProviderBio] = Field(default_factory=list)
    notable_cases: list[NotableCase] = Field(default_factory=list)
    awards: list[Award] = Field(default_factory=list)
    tone_guidelines: str = ""
    target_audience: list[str] = Field(default_factory=list)
    compliance_jurisdictions: list[str] = Field(default_factory=list)
