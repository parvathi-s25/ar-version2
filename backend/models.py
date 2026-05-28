"""
Phase 1 — Pydantic models for story JSON validation and compilation.

These models mirror the frontend story contract so the backend can:
 1. Validate story JSON from any source (HTTP upload, file, API call)
 2. Normalise field names, fill defaults, and catch timing violations
 3. Emit a clean frontend-ready orchestration JSON

All durations are in milliseconds (float). All positions are in meters (float).
Python version target: 3.12+
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Optional, Union
from pydantic import BaseModel, field_validator, model_validator, ConfigDict
import math


# ─── Enums ────────────────────────────────────────────────────────────────────

class ActionType(str, Enum):
    MOVE       = "move"
    POSE       = "pose"
    ROTATE     = "rotate"
    VISIBILITY = "visibility"
    SCALE      = "scale"


# ─── Sub-models ───────────────────────────────────────────────────────────────

class Vec3(BaseModel):
    """Page-local 3-D position in meters. Y is height above page surface."""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


class CharacterConfig(BaseModel):
    """Configuration for a single story character."""
    model_config = ConfigDict(extra="allow")  # allow future extensions

    displayName:            Optional[str]   = None
    assetUrl:               Optional[str]   = None   # GLB/GLTF URL; None → fallback mesh
    scale:                  Optional[float] = None   # explicit scale override
    targetHeightMeters:     float           = 0.12   # auto-scale target if scale is None
    footprintRadiusMeters:  float           = 0.030
    groundOffsetMeters:     float           = 0.0
    initialLocalPosition:   Vec3            = Vec3()
    initialRotationYDeg:    float           = 0.0

    @field_validator("footprintRadiusMeters")
    @classmethod
    def positive_footprint(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("footprintRadiusMeters must be > 0")
        return v


class TimelineAction(BaseModel):
    """A single timed action in the story timeline."""
    model_config = ConfigDict(extra="allow")

    id:             Optional[str]  = None
    characterId:    str
    type:           ActionType
    startMs:        float
    endMs:          Optional[float] = None  # filled by validator if missing

    # move / pose fields
    from_pos:       Optional[Vec3] = None   # alias: "from"
    to:             Optional[Vec3] = None
    position:       Optional[Vec3] = None
    rotationYDeg:   Optional[float] = None

    # rotate fields
    fromRotationYDeg: Optional[float] = None
    toRotationYDeg:   Optional[float] = None

    # visibility
    visible:        Optional[bool] = None

    # scale
    fromScale:      Optional[float] = None
    toScale:        Optional[float] = None

    # animation
    animationClip:      Optional[str]   = None
    clipFadeSeconds:    float           = 0.2

    model_config = ConfigDict(populate_by_name=True)

    @field_validator("startMs")
    @classmethod
    def non_negative_start(cls, v: float) -> float:
        if v < 0:
            raise ValueError("startMs must be >= 0")
        return v

    @model_validator(mode="after")
    def ensure_end_gte_start(self) -> "TimelineAction":
        if self.endMs is None:
            self.endMs = self.startMs
        elif self.endMs < self.startMs:
            raise ValueError(f"endMs ({self.endMs}) must be >= startMs ({self.startMs}) for action '{self.id}'")
        return self

    # Allow "from" as an alias in the raw dict before parsing (handled in StoryInput).


class StoryInput(BaseModel):
    """Raw story JSON from the client or file upload.
    This is what POST /api/story/validate and /api/story/compile receive.
    """
    model_config = ConfigDict(extra="allow")

    storyId:    Optional[str]  = None
    title:      Optional[str]  = None
    version:    Union[int, str, None] = 1
    durationMs: float
    loop:       bool           = True
    characters: dict[str, CharacterConfig]
    timeline:   list[dict[str, Any]]   # raw dicts so we can alias "from"

    @field_validator("durationMs")
    @classmethod
    def positive_duration(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("durationMs must be > 0")
        return v

    @field_validator("characters")
    @classmethod
    def at_least_one_character(cls, v: dict) -> dict:
        if not v:
            raise ValueError("Story must contain at least one character.")
        return v

    @field_validator("timeline")
    @classmethod
    def non_empty_timeline(cls, v: list) -> list:
        if not v:
            raise ValueError("Story timeline must contain at least one action.")
        return v


# ─── Compiled Output Models ───────────────────────────────────────────────────

class ValidationWarning(BaseModel):
    code:    str
    message: str
    actionId: Optional[str] = None


class ValidationResult(BaseModel):
    valid:    bool
    errors:   list[str]          = []
    warnings: list[ValidationWarning] = []


class CompiledStory(BaseModel):
    """Frontend-ready story orchestration JSON produced by /api/story/compile."""
    storyId:    str
    title:      str
    version:    int             = 2
    durationMs: float
    loop:       bool
    characters: dict[str, CharacterConfig]
    timeline:   list[TimelineAction]
    validation: ValidationResult
    compiledAt: str             = ""   # ISO timestamp filled at compile time
