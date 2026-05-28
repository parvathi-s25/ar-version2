# AR Storytelling — Phase 1 Backend

Python 3.12+ · FastAPI · Pydantic v2 · Uvicorn

## Purpose

This backend validates and compiles story JSON files before they are sent to
the WebXR AR frontend renderer (Phase 4).

It performs:
- JSON schema validation (Pydantic)
- Timeline action parsing and field checks
- Character reference validation
- Timing span enforcement
- Overlap detection warnings
- Dead-zone detection warnings
- Clean compiled output for the frontend

## Setup

```bash
cd backend
pip install -r requirements.txt
```

## Run dev server

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/api/health` | JSON health |
| POST | `/api/story/validate` | Validate only (no compile) |
| POST | `/api/story/compile` | Validate + compile |
| POST | `/api/story/upload` | Upload a .json story file |
| GET | `/api/story/sample` | Return built-in sample story |
| GET | `/api/story/schema` | Return JSON schema |

Interactive docs: http://localhost:8000/docs

## Story JSON format

See `../public/story/sample-story.json` for a working example.

Required fields:
```json
{
  "durationMs": 18000,
  "characters": { "hero": { ... } },
  "timeline": [ { "characterId": "hero", "type": "move", "startMs": 0 } ]
}
```

## Python version

Target: Python 3.12. Also works on 3.11 and 3.13.
Do not use Python 3.1.x (ancient; EOL since 2011).
