"""
Phase 1 — Story compiler.

Takes a StoryInput (already Pydantic-validated) and produces:
 - A list of ValidationWarnings (non-fatal issues)
 - A list of errors (fatal issues, stored separately from Pydantic errors)
 - A CompiledStory ready for the frontend renderer

The compiler performs the following passes:
 1. Alias normalisation: "from" → "from_pos" (JSON key reserved in Python)
 2. Timeline action parsing with per-action error collection
 3. Character reference validation (every characterId must exist)
 4. Timing span validation (actions must fit within durationMs)
 5. Action-type-specific field validation
 6. Overlap warning (actions on same character overlap in time)
 7. Asset URL presence check (warns if assetUrl is missing)
 8. Dead-zone check (periods with no actions for a character → warning)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from models import (
    ActionType,
    CharacterConfig,
    CompiledStory,
    StoryInput,
    TimelineAction,
    ValidationResult,
    ValidationWarning,
)


def compile_story(raw: StoryInput) -> tuple[CompiledStory, ValidationResult]:
    """Compile a raw StoryInput into a CompiledStory.

    Returns (compiled, result) where result.valid indicates whether the story
    can safely be sent to the frontend renderer.
    """
    errors:   list[str]              = []
    warnings: list[ValidationWarning] = []
    known_ids: set[str]              = set(raw.characters.keys())

    # ── Pass 1: Parse timeline actions ──────────────────────────────────────
    parsed_actions: list[TimelineAction] = []
    for idx, raw_action in enumerate(raw.timeline):
        action_id = raw_action.get("id") or f"action_{idx}"
        try:
            # Alias "from" → "from_pos" (Python keyword conflict).
            normalised = _normalise_action_dict(raw_action)
            action = TimelineAction.model_validate(normalised)
            if not action.id:
                action.id = action_id
            parsed_actions.append(action)
        except Exception as exc:
            errors.append(f"Action '{action_id}' parse error: {exc}")

    # ── Pass 2: Character reference check ────────────────────────────────────
    for action in parsed_actions:
        if action.characterId not in known_ids:
            errors.append(
                f"Action '{action.id}' references unknown character '{action.characterId}'. "
                f"Known characters: {sorted(known_ids)}"
            )

    # ── Pass 3: Timing span validation ────────────────────────────────────────
    for action in parsed_actions:
        end = action.endMs or action.startMs
        if end > raw.durationMs:
            warnings.append(ValidationWarning(
                code="ACTION_EXCEEDS_DURATION",
                message=(
                    f"Action '{action.id}' ends at {end}ms which exceeds "
                    f"story durationMs ({raw.durationMs}ms). "
                    "The action will be clamped by the runtime."
                ),
                actionId=action.id
            ))
        if action.startMs >= raw.durationMs:
            warnings.append(ValidationWarning(
                code="ACTION_STARTS_AFTER_END",
                message=(
                    f"Action '{action.id}' starts at {action.startMs}ms which is "
                    f">= durationMs ({raw.durationMs}ms). It will never play."
                ),
                actionId=action.id
            ))

    # ── Pass 4: Action-type-specific validation ────────────────────────────────
    for action in parsed_actions:
        _validate_action_fields(action, warnings)

    # ── Pass 5: Overlap detection per character ────────────────────────────────
    _detect_overlaps(parsed_actions, warnings)

    # ── Pass 6: Asset URL check ────────────────────────────────────────────────
    for char_id, char_cfg in raw.characters.items():
        if not char_cfg.assetUrl:
            warnings.append(ValidationWarning(
                code="NO_ASSET_URL",
                message=(
                    f"Character '{char_id}' has no assetUrl. "
                    "The frontend will render a fallback debug mesh."
                )
            ))

    # ── Pass 7: Dead-zone check ────────────────────────────────────────────────
    _detect_dead_zones(raw, parsed_actions, warnings)

    # ── Build result ───────────────────────────────────────────────────────────
    valid = len(errors) == 0
    result = ValidationResult(valid=valid, errors=errors, warnings=warnings)

    compiled = CompiledStory(
        storyId    = raw.storyId or str(uuid.uuid4()),
        title      = raw.title or "Untitled Story",
        version    = 2,
        durationMs = raw.durationMs,
        loop       = raw.loop,
        characters = raw.characters,
        timeline   = parsed_actions,
        validation = result,
        compiledAt = datetime.now(tz=timezone.utc).isoformat()
    )

    return compiled, result


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _normalise_action_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Rename 'from' key → 'from_pos' so Pydantic can accept it."""
    out = dict(d)
    if "from" in out:
        out["from_pos"] = out.pop("from")
    return out


def _validate_action_fields(action: TimelineAction, warnings: list[ValidationWarning]) -> None:
    atype = action.type

    if atype == ActionType.MOVE:
        if action.from_pos is None and action.to is None:
            warnings.append(ValidationWarning(
                code="MOVE_MISSING_FROM_TO",
                message=f"Action '{action.id}' type=move is missing both 'from' and 'to' fields.",
                actionId=action.id
            ))

    elif atype == ActionType.POSE:
        if action.position is None:
            warnings.append(ValidationWarning(
                code="POSE_MISSING_POSITION",
                message=f"Action '{action.id}' type=pose is missing 'position' field.",
                actionId=action.id
            ))

    elif atype == ActionType.ROTATE:
        if action.fromRotationYDeg is None or action.toRotationYDeg is None:
            warnings.append(ValidationWarning(
                code="ROTATE_MISSING_ANGLES",
                message=(
                    f"Action '{action.id}' type=rotate is missing "
                    "'fromRotationYDeg' or 'toRotationYDeg'."
                ),
                actionId=action.id
            ))

    elif atype == ActionType.VISIBILITY:
        if action.visible is None:
            warnings.append(ValidationWarning(
                code="VISIBILITY_MISSING_FLAG",
                message=f"Action '{action.id}' type=visibility is missing 'visible' boolean.",
                actionId=action.id
            ))

    elif atype == ActionType.SCALE:
        if action.fromScale is None or action.toScale is None:
            warnings.append(ValidationWarning(
                code="SCALE_MISSING_VALUES",
                message=(
                    f"Action '{action.id}' type=scale is missing "
                    "'fromScale' or 'toScale'."
                ),
                actionId=action.id
            ))


def _detect_overlaps(actions: list[TimelineAction], warnings: list[ValidationWarning]) -> None:
    """Warn when two actions on the same character have overlapping time spans."""
    from itertools import combinations

    # Group by character.
    by_char: dict[str, list[TimelineAction]] = {}
    for a in actions:
        by_char.setdefault(a.characterId, []).append(a)

    for char_id, char_actions in by_char.items():
        for a, b in combinations(char_actions, 2):
            a_end = a.endMs or a.startMs
            b_end = b.endMs or b.startMs
            # Overlap: a starts before b ends AND b starts before a ends.
            if a.startMs < b_end and b.startMs < a_end:
                warnings.append(ValidationWarning(
                    code="ACTION_OVERLAP",
                    message=(
                        f"Character '{char_id}': actions '{a.id}' "
                        f"[{a.startMs}–{a_end}ms] and '{b.id}' "
                        f"[{b.startMs}–{b_end}ms] overlap. "
                        "The later-listed action will overwrite the earlier one."
                    ),
                    actionId=a.id
                ))


def _detect_dead_zones(
    raw: StoryInput,
    actions: list[TimelineAction],
    warnings: list[ValidationWarning],
    min_gap_ms: float = 1000.0
) -> None:
    """Warn if a character has a gap of > min_gap_ms with no actions."""
    for char_id in raw.characters:
        char_actions = sorted(
            [a for a in actions if a.characterId == char_id],
            key=lambda a: a.startMs
        )
        if not char_actions:
            warnings.append(ValidationWarning(
                code="CHARACTER_NO_ACTIONS",
                message=f"Character '{char_id}' has no timeline actions.",
            ))
            continue

        # Check gap before first action.
        if char_actions[0].startMs > min_gap_ms:
            warnings.append(ValidationWarning(
                code="DEAD_ZONE",
                message=(
                    f"Character '{char_id}' has {char_actions[0].startMs:.0f}ms "
                    "with no actions at the start of the story."
                )
            ))

        # Check gaps between consecutive actions.
        for i in range(len(char_actions) - 1):
            prev_end = char_actions[i].endMs or char_actions[i].startMs
            next_start = char_actions[i + 1].startMs
            gap = next_start - prev_end
            if gap > min_gap_ms:
                warnings.append(ValidationWarning(
                    code="DEAD_ZONE",
                    message=(
                        f"Character '{char_id}' has a {gap:.0f}ms gap with no actions "
                        f"between actions '{char_actions[i].id}' and '{char_actions[i+1].id}'."
                    )
                ))
