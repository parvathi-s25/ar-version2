"""
Phase 1 Backend — AR Storytelling Story Orchestration API

Stack: Python 3.12+, FastAPI, Pydantic v2, Uvicorn

Endpoints:
  GET  /                          Health check
  GET  /api/health                JSON health check
  POST /api/story/validate        Validate story JSON (no compilation)
  POST /api/story/compile         Validate + compile story JSON
  POST /api/story/upload          Accept story JSON file + return compiled output
  GET  /api/story/schema          Return the expected story JSON schema
  GET  /api/story/sample          Return the built-in two-character sample story

Usage:
  cd backend
  pip install -r requirements.txt
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload

CORS is configured for localhost dev and can be restricted in production.
"""
from __future__ import annotations

import json
import os
import pathlib
from datetime import datetime, timezone
from typing import Any

import aiofiles
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from models import CompiledStory, StoryInput, ValidationResult
from story_compiler import compile_story

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="AR Storytelling — Phase 1 Backend",
    description=(
        "Story orchestration API: validate, compile, and serve story JSON "
        "for the WebXR AR storytelling frontend."
    ),
    version="1.0.0"
)

# CORS: allow the Vite dev server and any Vercel/Netlify deploy.
# Tighten allowed_origins before production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "https://*.vercel.app",
        "https://*.netlify.app",
    ],
    allow_origin_regex=r"https://.*\.vercel\.app|https://.*\.netlify\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Path to the sample story shipped with the frontend.
_SAMPLE_STORY_PATH = pathlib.Path(__file__).parent.parent / "public" / "story" / "sample-story.json"


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
async def root():
    return {"status": "ok", "service": "AR Storytelling Phase 1 Backend", "timestamp": _now()}


@app.get("/api/health", tags=["Health"])
async def health():
    return {
        "status": "ok",
        "timestamp": _now(),
        "version": "1.0.0",
        "python": "3.12+"
    }


@app.post("/api/story/validate", tags=["Story"], response_model=ValidationResult)
async def validate_story(request: Request):
    """Validate story JSON without compiling.
    Returns a ValidationResult with any errors and warnings.
    Does not transform the story — useful for a client-side pre-check.
    """
    raw_body = await _parse_json_body(request)
    story_input, parse_errors = _parse_story_input(raw_body)

    if parse_errors:
        return ValidationResult(valid=False, errors=parse_errors)

    _, result = compile_story(story_input)
    return result


@app.post("/api/story/compile", tags=["Story"], response_model=CompiledStory)
async def compile_story_endpoint(request: Request):
    """Validate + compile story JSON.
    Returns a CompiledStory with normalised timeline actions and validation info.
    Raises HTTP 422 if there are hard errors (invalid schema or logic errors).
    """
    raw_body = await _parse_json_body(request)
    story_input, parse_errors = _parse_story_input(raw_body)

    if parse_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": parse_errors}
        )

    compiled, result = compile_story(story_input)

    if not result.valid:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": result.errors, "warnings": [w.model_dump() for w in result.warnings]}
        )

    return compiled


@app.post("/api/story/upload", tags=["Story"])
async def upload_story_file(file: UploadFile = File(...)):
    """Accept a story JSON file upload and return the compiled output.
    Useful for tooling that produces story files offline.
    """
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .json files are accepted."
        )

    # Limit file size to 2 MB to prevent abuse.
    MAX_SIZE = 2 * 1024 * 1024
    contents = await file.read(MAX_SIZE + 1)
    if len(contents) > MAX_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Story file must be <= 2 MB."
        )

    try:
        raw_body = json.loads(contents)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid JSON: {exc}"
        )

    story_input, parse_errors = _parse_story_input(raw_body)
    if parse_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": parse_errors}
        )

    compiled, result = compile_story(story_input)
    return {
        "filename": file.filename,
        "compiled": compiled.model_dump(),
        "validation": result.model_dump()
    }


@app.get("/api/story/sample", tags=["Story"])
async def get_sample_story():
    """Return the built-in two-character sample story (also served as a static file
    by the Vite frontend at /story/sample-story.json).
    """
    if not _SAMPLE_STORY_PATH.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sample story file not found."
        )
    async with aiofiles.open(_SAMPLE_STORY_PATH, "r") as f:
        raw = json.loads(await f.read())
    return raw


@app.get("/api/story/schema", tags=["Story"])
async def get_story_schema():
    """Return the JSON schema for the StoryInput model.
    Useful for client-side validation tooling.
    """
    return StoryInput.model_json_schema()


# ─── Error handlers ───────────────────────────────────────────────────────────

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "status": exc.status_code, "timestamp": _now()}
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    # Never expose internal tracebacks in production.
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error.", "timestamp": _now()}
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _parse_json_body(request: Request) -> dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body must be valid JSON."
        )


def _parse_story_input(raw: dict[str, Any]) -> tuple[StoryInput | None, list[str]]:
    """Parse raw dict into StoryInput. Returns (model, []) on success or (None, errors) on failure."""
    try:
        return StoryInput.model_validate(raw), []
    except ValidationError as exc:
        return None, [f"{'.'.join(str(l) for l in e['loc'])}: {e['msg']}" for e in exc.errors()]


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()
