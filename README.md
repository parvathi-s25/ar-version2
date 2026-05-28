# AR Storytelling MVP — v2

WebXR · Three.js · Vite · FastAPI (Phase 1 backend)

A browser-based AR storytelling system that renders animated 3D characters
on top of a physical book or page using the device back camera.

---

## What's implemented

### Phase 2/3 — WebXR tracking + page anchor
- WebXR `immersive-ar` + hit-test plane detection (ARCore/ARKit)
- Tap to lock page · **Double-tap** to re-lock
- Reticle with colour states: scanning (grey) → ready (blue) → locked (hides)
- Page-local X-Z coordinate system (Y = page normal)
- Page size **presets**: A4 Portrait, A4 Landscape, Book Page, US Letter, Square
- Manual width/height resize controls
- Locked-plane: reticle and hit-test pause after lock; Reset re-enables scanning
- **Camera fallback** for non-WebXR devices: `getUserMedia()` back-camera preview
  overlaid with the same character layer (no world-lock, no real scale)
- WebXR compatibility diagnostics (specific error reason in the UI)
- Desktop mock mode for development without a phone

### Phase 3 — Boundary clamp
- Page-local boundary clamp: `[marginMeters + footprintRadius, …]` on X and Z
- BoundaryClamp JSON contract with all limit values
- Debug actor + footprint circle constrained to clamp zone

### Phase 4 — Story runtime
- `GLTFLoader` with per-character load progress bars
- Auto-scale from bounding box if `scale` not explicitly set
- Fallback debug mesh (capsule + sphere) when asset URL is absent or fails
- `AnimationMixer` with **named clip lookup** and **cross-fade** (`fadeIn`/`crossFadeTo`)
- Timeline action types: `move`, `pose`, `rotate`, `visibility`, `scale`
- Ease-in-out interpolation on all animated actions
- **Multi-character support**: independent state per character
- **Overlap prevention solver**: 2-D circle push-apart in page-local X/Z, 3 iterations
- Deterministic replay: state rebuilt from t=0 each frame
- Loop / pause / restart / stop controls
- Story progress bar in debug panel
- Phase 4 runtime JSON contract in debug panel

### Phase 1 — Python backend
- FastAPI + Pydantic v2 story validation and compilation API
- Endpoints: `/validate`, `/compile`, `/upload`, `/sample`, `/schema`
- Multi-pass compiler: character references, timing spans, field checks, overlap warnings, dead-zone warnings
- Interactive docs at `http://localhost:8000/docs`

---

## Project structure

```
ar-storytelling-option-a/
  index.html
  vite.config.js
  package.json

  public/
    story/
      sample-story.json          ← two-character demo story
    assets/characters/
      sample-character.gltf      ← placeholder GLB mesh
      README.md                  ← how to add your own GLB assets

  src/
    main.js                      ← app entry, wires all modules
    styles.css

    core/
      AppState.js                ← central state (XR, page anchor, clamp)
      PageAnchor.js              ← page coordinate system + JSON contracts
      BoundaryClamp.js           ← page-local boundary clamp
      TrackingConfidence.js      ← tracking state JSON

    webxr/
      WebXRHitTestManager.js     ← WebXR hit-test, reticle update
      CameraFallback.js          ← getUserMedia() camera fallback

    render/
      SceneFactory.js            ← Three.js scene, camera, lights, reticle
      DebugPageRenderer.js       ← page boundary + clamp + debug actor mesh

    ui/
      DebugPanel.js              ← full debug panel + AR HUD

    utils/
      math.js                    ← clamp, round, vectorToJSON, etc.

    phase4/
      StoryRuntime.js            ← GLTF loading, AnimationMixer, timeline engine

  backend/
    main.py                      ← FastAPI app
    models.py                    ← Pydantic models
    story_compiler.py            ← validation + compilation passes
    requirements.txt
    README.md
```

---

## Frontend setup

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
npm run preview
```

## Backend setup

```bash
cd backend
pip install -r requirements.txt   # Python 3.12+
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# docs at http://localhost:8000/docs
```

## Deploy to Vercel (frontend only)

```
Framework Preset : Vite
Build Command    : npm run build
Output Directory : dist
Install Command  : npm install
```

---

## Device compatibility

| Device | Status | Notes |
|---|---|---|
| Android Chrome + ARCore | ✅ Full AR | Hit-test + world-locked |
| iOS Safari 16+ | ⚠ Partial | WebXR AR availability varies; use camera fallback |
| Desktop Chrome/Firefox | ✅ Mock mode | Desktop grid + full UI |
| Non-ARCore Android | 📷 Camera fallback | Live video overlay, no world-lock |

---

## Adding your own GLB/GLTF character

1. Place your `.glb` or `.gltf` (+ bin files) in `public/assets/characters/`.
2. In your story JSON, set `"assetUrl": "/assets/characters/your-file.glb"`.
3. Set `"scale"` or `"targetHeightMeters"` to control size.
4. Animation clips must be named in the GLB and referenced by name in `animationClip` fields.

See `public/assets/characters/README.md` for details.

---

## Coordinate system

```
Page local origin: centre of locked page anchor
+X : page width direction
+Z : page height/depth direction
+Y : page normal (up from page surface)
Page surface = local Y = 0
```

Characters are placed in page-local coordinates and parented to the page anchor
`Object3D` matrix, so they move with the page if it is re-locked.

---

## Known limitations (honest)

- Camera fallback is NOT world-locked — characters overlay the video but do not
  track real-world surfaces.
- OpenCV/Canny page boundary detection is not implemented (Option D hybrid — future).
- ORB-SLAM3/WASM is not implemented (research track — future).
- Persistent anchors across sessions are not implemented.
- iOS WebXR AR support varies by device and Safari version.
- Audio narration and text overlay are not implemented yet.
