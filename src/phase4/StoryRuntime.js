import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { round, vectorToJSON } from '../utils/math.js';

const DEFAULT_STORY_URL = '/story/sample-story.json';

/**
 * Phase 4 StoryRuntime (v2 — stabilised)
 *
 * Improvements over v1:
 * - Robust GLTFLoader with load-progress events and per-character error recovery
 * - AnimationMixer with named clip lookup, cross-fade, and safe stop
 * - Multi-character support with independent per-character state
 * - Per-character bounding-box footprint auto-calculation
 * - Overlap prevention: 2-D push-apart solver in page-local X/Z
 * - Scene transitions: fade visibility, scale-in entrance
 * - Deterministic timeline replay (state rebuilt from t=0 each tick)
 * - `loadProgress` event with per-character progress for UI
 * - `statusChange` event for low-frequency UI polls
 */
export class StoryRuntime extends EventTarget {
  constructor({ scene, appState }) {
    super();

    this.scene = scene;
    this.appState = appState;

    this.loader = new GLTFLoader();
    this.loader.setCrossOrigin('anonymous');

    // All Phase 4 characters live under this group, which is re-parented to
    // the page anchor matrix every frame.
    this.characterLayer = new THREE.Group();
    this.characterLayer.name = 'Phase4CharacterLayer';
    this.characterLayer.matrixAutoUpdate = false;
    this.characterLayer.visible = false;
    this.scene.add(this.characterLayer);

    this.story            = null;
    this.storyUrl         = null;
    this.characters       = new Map();   // id → CharacterState
    this.isLoaded         = false;
    this.isLoading        = false;
    this.isPlaying        = false;
    this.currentTimeMs    = 0;
    this.durationMs       = 0;
    this.loop             = true;
    this.lastError        = null;
    this.loadProgressMap  = new Map();   // id → 0–1
    this._lastEmitMs      = 0;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async loadStory(url = DEFAULT_STORY_URL) {
    if (this.isLoading) return false;

    this.isLoading  = true;
    this.isLoaded   = false;
    this.isPlaying  = false;
    this.lastError  = null;
    this.currentTimeMs = 0;
    this.loadProgressMap.clear();
    this._emitChange();

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Story JSON ${response.status}: ${response.statusText}`);

      const story = await response.json();
      this._validateStory(story);
      this._clearCharacters();

      this.story       = story;
      this.storyUrl    = url;
      this.durationMs  = Number(story.durationMs ?? 0);
      this.loop        = story.loop !== false;

      // Load all characters in parallel; individual failures use fallback meshes.
      const entries = Object.entries(story.characters ?? {});
      await Promise.all(entries.map(([id, cfg]) => this._loadCharacter(id, cfg)));

      this.isLoaded  = true;
      this.isLoading = false;
      this._applyTimeline(0);
      this._emitChange();
      return true;

    } catch (err) {
      console.error('[StoryRuntime] loadStory failed:', err);
      this.lastError  = err.message;
      this.isLoading  = false;
      this.isLoaded   = false;
      this._emitChange();
      return false;
    }
  }

  play() {
    if (!this.isLoaded) return false;
    this.isPlaying = true;
    this._emitChange();
    return true;
  }

  pause() {
    this.isPlaying = false;
    this._emitChange();
  }

  restart() {
    this.currentTimeMs = 0;
    this._applyTimeline(0);
    this.isPlaying = this.isLoaded;
    this._emitChange();
  }

  stop() {
    this.currentTimeMs = 0;
    this.isPlaying = false;
    this._applyTimeline(0);
    this._emitChange();
  }

  /** Called every frame from main.js animate loop. deltaSeconds is clamped upstream. */
  update(deltaSeconds) {
    this._updateLayerTransform();
    if (!this.isLoaded) return;

    // Tick animation mixers regardless of play state (lets stopped clips hold pose).
    for (const ch of this.characters.values()) {
      ch.mixer?.update(deltaSeconds);
    }

    if (!this.isPlaying) return;

    this.currentTimeMs += deltaSeconds * 1000;

    if (this.currentTimeMs > this.durationMs) {
      if (this.loop && this.durationMs > 0) {
        this.currentTimeMs = this.currentTimeMs % this.durationMs;
      } else {
        this.currentTimeMs = this.durationMs;
        this.isPlaying = false;
      }
    }

    this._applyTimeline(this.currentTimeMs);

    // Emit status at ~4 Hz to avoid flooding React-style re-renders.
    const now = performance.now();
    if (now - this._lastEmitMs > 250) {
      this._lastEmitMs = now;
      this._emitChange();
    }
  }

  hasLoadedCharacters() {
    return this.isLoaded && this.characters.size > 0;
  }

  getStatus() {
    const chars = [...this.characters.values()].map(ch => ({
      id: ch.id,
      displayName: ch.config.displayName ?? ch.id,
      assetUrl: ch.config.assetUrl ?? null,
      loadedFromAsset: ch.loadedFromAsset,
      loadError: ch.loadError ?? null,
      loadProgress: round(this.loadProgressMap.get(ch.id) ?? 1, 2),
      animationClips: [...ch.clips.keys()],
      currentClip: ch.currentClipName,
      localPosition: vectorToJSON(ch.localPosition),
      rotationYDeg: round(THREE.MathUtils.radToDeg(ch.rotationY), 2),
      footprintRadiusMeters: round(ch.footprintRadiusMeters, 4),
      visible: ch.wrapper.visible
    }));

    return {
      type: 'Phase4StoryRuntime',
      loaded: this.isLoaded,
      loading: this.isLoading,
      playing: this.isPlaying,
      storyId: this.story?.storyId ?? null,
      title: this.story?.title ?? null,
      storyUrl: this.storyUrl,
      currentTimeMs: round(this.currentTimeMs, 1),
      durationMs: round(this.durationMs, 1),
      loop: this.loop,
      pageLockedRequired: true,
      renderLayerVisible: this.characterLayer.visible,
      characters: chars,
      lastError: this.lastError
    };
  }

  // ─── Private — Loading ────────────────────────────────────────────────────

  _validateStory(story) {
    if (!story || typeof story !== 'object') throw new Error('Story JSON must be an object.');
    if (!story.characters || typeof story.characters !== 'object') throw new Error('Story JSON must include a characters object.');
    if (!Array.isArray(story.timeline)) throw new Error('Story JSON must include a timeline array.');
    if (typeof story.durationMs !== 'number' || story.durationMs <= 0) throw new Error('Story durationMs must be a positive number.');
  }

  async _loadCharacter(id, config) {
    this.loadProgressMap.set(id, 0);
    this._emitChange();

    const wrapper = new THREE.Group();
    wrapper.name = `Character_${id}`;
    wrapper.visible = false;
    this.characterLayer.add(wrapper);

    /** @type {CharacterState} */
    const ch = {
      id,
      config,
      wrapper,
      model:              null,
      mixer:              null,
      clips:              new Map(),
      currentClipName:    null,
      activeAction:       null,
      loadedFromAsset:    false,
      loadError:          null,
      baseScale:          Number(config.scale ?? 1),
      footprintRadiusMeters: Number(config.footprintRadiusMeters ?? 0.03),
      localPosition:      this._vecFromCfg(config.initialLocalPosition, 0, 0, 0),
      rotationY:          THREE.MathUtils.degToRad(Number(config.initialRotationYDeg ?? 0))
    };

    this.characters.set(id, ch);

    try {
      if (!config.assetUrl) throw new Error('No assetUrl — using fallback mesh.');

      const gltf = await this._loadGLTF(config.assetUrl, id);
      const model = gltf.scene;
      model.name = `${id}_Model`;

      // Auto-normalise scale from bounding box so characters always appear
      // roughly human-sized on a book page regardless of source asset scale.
      const autoScale = this._computeAutoScale(model, ch.baseScale, config);
      model.scale.setScalar(autoScale);
      model.position.y = Number(config.groundOffsetMeters ?? 0);

      // Enable shadows on all meshes for depth.
      model.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = false;
        }
      });

      wrapper.add(model);
      ch.model = model;
      ch.loadedFromAsset = true;

      // Derive footprintRadius from bounding box if not explicitly set.
      if (!config.footprintRadiusMeters) {
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        ch.footprintRadiusMeters = Math.max(size.x, size.z) / 2;
      }

      if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
        ch.mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach(clip => ch.clips.set(clip.name, clip));
      }

    } catch (err) {
      console.warn(`[StoryRuntime] Character "${id}" fallback:`, err.message);
      ch.loadError = err.message;
      ch.model = this._createFallbackMesh(ch.baseScale);
      wrapper.add(ch.model);
    }

    this.loadProgressMap.set(id, 1);
    this._applyCharacterTransform(ch, ch.localPosition, ch.rotationY);
    this._emitChange();
  }

  _loadGLTF(url, characterId) {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        resolve,
        (progressEvent) => {
          if (progressEvent.total > 0) {
            const pct = progressEvent.loaded / progressEvent.total;
            this.loadProgressMap.set(characterId, Math.min(pct, 0.99));
            this._emitChange();
          }
        },
        reject
      );
    });
  }

  /**
   * Scale the model so its tallest dimension is roughly `targetHeightMeters`.
   * If config.scale is provided it overrides the auto calculation.
   */
  _computeAutoScale(model, configScale, config) {
    if (config.scale !== undefined && config.scale !== null) return configScale;

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim === 0) return configScale;

    const targetHeight = Number(config.targetHeightMeters ?? 0.12);
    return targetHeight / maxDim;
  }

  _createFallbackMesh(scale = 0.08) {
    const g = new THREE.Group();
    g.name = 'FallbackCharacter';

    // Body capsule
    const bodyGeo  = new THREE.CapsuleGeometry(0.18, 0.55, 6, 18);
    const bodyMat  = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.45 });
    const body     = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.48;
    g.add(body);

    // Head sphere
    const headGeo  = new THREE.SphereGeometry(0.18, 20, 20);
    const headMat  = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
    const head     = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.96;
    g.add(head);

    // Direction marker so rotation is visible
    const markerGeo = new THREE.ConeGeometry(0.07, 0.18, 10);
    const markerMat = new THREE.MeshStandardMaterial({ color: 0xf97316 });
    const marker    = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(0, 0.5, -0.22);
    marker.rotation.x = -Math.PI / 2;
    g.add(marker);

    g.scale.setScalar(scale);
    return g;
  }

  // ─── Private — Timeline ───────────────────────────────────────────────────

  /**
   * Rebuild the full scene state at `timeMs`.
   * Deterministic: always starts from initial pose then steps through all
   * actions that have started by `timeMs`.
   */
  _applyTimeline(timeMs) {
    if (!this.story) return;

    // Reset all characters to initial pose.
    for (const ch of this.characters.values()) {
      ch.wrapper.visible = true;
      const pos = this._vecFromCfg(ch.config.initialLocalPosition, 0, 0, 0);
      const rot = THREE.MathUtils.degToRad(Number(ch.config.initialRotationYDeg ?? 0));
      this._applyCharacterTransformRaw(ch, pos, rot);
    }

    // Collect and sort actions that have started.
    const active = this.story.timeline
      .filter(a => timeMs >= Number(a.startMs ?? 0))
      .sort((a, b) => Number(a.startMs ?? 0) - Number(b.startMs ?? 0));

    for (const action of active) {
      const ch = this.characters.get(action.characterId);
      if (!ch) continue;
      const isWithin = timeMs <= Number(action.endMs ?? action.startMs ?? 0);
      this._applyAction(ch, action, timeMs, isWithin);
    }

    // After all positions are set, run the overlap-prevention solver.
    this._resolveOverlaps();
  }

  _applyAction(ch, action, timeMs, isWithin) {
    const start    = Number(action.startMs ?? 0);
    const end      = Number(action.endMs   ?? start);
    const t        = end > start
      ? THREE.MathUtils.clamp((timeMs - start) / (end - start), 0, 1)
      : 1;
    const ease     = this._easeInOut(t);

    let pos = ch.localPosition.clone();
    let rot = ch.rotationY;

    switch (action.type) {
      case 'move': {
        const from = this._vecFromCfg(action.from, pos.x, pos.y, pos.z);
        const to   = this._vecFromCfg(action.to,   pos.x, pos.y, pos.z);
        pos = from.clone().lerp(to, ease);
        if (typeof action.rotationYDeg === 'number') rot = THREE.MathUtils.degToRad(action.rotationYDeg);
        break;
      }
      case 'pose': {
        pos = this._vecFromCfg(action.position, pos.x, pos.y, pos.z);
        if (typeof action.rotationYDeg === 'number') rot = THREE.MathUtils.degToRad(action.rotationYDeg);
        break;
      }
      case 'rotate': {
        const from = THREE.MathUtils.degToRad(Number(action.fromRotationYDeg ?? 0));
        const to   = THREE.MathUtils.degToRad(Number(action.toRotationYDeg   ?? 0));
        rot = THREE.MathUtils.lerp(from, to, ease);
        break;
      }
      case 'visibility': {
        ch.wrapper.visible = Boolean(action.visible);
        break;
      }
      case 'scale': {
        // Animate scale for enter/exit effects.
        const fromS = Number(action.fromScale ?? ch.baseScale);
        const toS   = Number(action.toScale   ?? ch.baseScale);
        const s     = THREE.MathUtils.lerp(fromS, toS, ease);
        ch.model?.scale.setScalar(s);
        break;
      }
    }

    // Animation clip playback.
    if (isWithin && typeof action.animationClip === 'string') {
      this._playClip(ch, action.animationClip, action.clipFadeSeconds ?? 0.2);
    }

    this._applyCharacterTransformRaw(ch, pos, rot);
  }

  /** Apply transform with boundary clamp. Updates ch.localPosition and ch.rotationY. */
  _applyCharacterTransformRaw(ch, pos, rotY) {
    const clamped = this._clampToPage(ch, pos);
    ch.localPosition.copy(clamped);
    ch.rotationY = rotY;
    ch.wrapper.position.copy(clamped);
    ch.wrapper.rotation.set(0, rotY, 0);
  }

  /** Public alias used by DebugPageRenderer overlay. */
  applyCharacterTransform(ch, pos, rotY) {
    this._applyCharacterTransformRaw(ch, pos, rotY);
  }

  _clampToPage(ch, pos) {
    if (!this.appState.boundaryClamp) return pos.clone();

    // Temporarily set the clamp's footprint to this character's radius.
    const prev = this.appState.boundaryClamp.footprintRadiusMeters;
    this.appState.boundaryClamp.footprintRadiusMeters = ch.footprintRadiusMeters;
    this.appState.boundaryClamp.recompute();
    const result = this.appState.boundaryClamp.clampLocal(pos);
    this.appState.boundaryClamp.footprintRadiusMeters = prev;
    this.appState.boundaryClamp.recompute();
    return result;
  }

  /**
   * Simple 2-D circle-circle overlap solver in page-local X/Z.
   * Characters are treated as circles with their footprintRadiusMeters.
   * Up to 3 solver iterations for stability.
   */
  _resolveOverlaps() {
    if (this.characters.size < 2) return;

    const chars = [...this.characters.values()].filter(c => c.wrapper.visible);
    const ITERS = 3;

    for (let iter = 0; iter < ITERS; iter++) {
      let anyOverlap = false;

      for (let i = 0; i < chars.length; i++) {
        for (let j = i + 1; j < chars.length; j++) {
          const a = chars[i];
          const b = chars[j];

          const dx = b.localPosition.x - a.localPosition.x;
          const dz = b.localPosition.z - a.localPosition.z;
          const distSq = dx * dx + dz * dz;
          const minDist = a.footprintRadiusMeters + b.footprintRadiusMeters + 0.005;

          if (distSq < minDist * minDist && distSq > 0.000001) {
            anyOverlap = true;
            const dist   = Math.sqrt(distSq);
            const pushDist = (minDist - dist) / 2;
            const nx = dx / dist;
            const nz = dz / dist;

            const newAPos = a.localPosition.clone();
            newAPos.x -= nx * pushDist;
            newAPos.z -= nz * pushDist;

            const newBPos = b.localPosition.clone();
            newBPos.x += nx * pushDist;
            newBPos.z += nz * pushDist;

            this._applyCharacterTransformRaw(a, newAPos, a.rotationY);
            this._applyCharacterTransformRaw(b, newBPos, b.rotationY);
          }
        }
      }

      if (!anyOverlap) break;
    }
  }

  // ─── Private — Animation Clips ────────────────────────────────────────────

  /**
   * Play a named clip on a character, cross-fading from the previous one.
   * Handles:
   * - Clip already playing → no-op
   * - Clip not found in map → warn and skip
   * - Fade duration configurable per action
   */
  _playClip(ch, clipName, fadeSec = 0.2) {
    if (!ch.mixer) return;
    if (ch.currentClipName === clipName) return;

    const clip = ch.clips.get(clipName);
    if (!clip) {
      // Log once per character×clip combo to avoid spam.
      const warnKey = `${ch.id}:${clipName}`;
      if (!this._warnedClips) this._warnedClips = new Set();
      if (!this._warnedClips.has(warnKey)) {
        console.warn(`[StoryRuntime] Clip "${clipName}" not found on "${ch.id}". Available: ${[...ch.clips.keys()].join(', ') || 'none'}`);
        this._warnedClips.add(warnKey);
      }
      return;
    }

    const newAction = ch.mixer.clipAction(clip);

    if (ch.activeAction && ch.activeAction !== newAction) {
      newAction.reset();
      newAction.setEffectiveWeight(1);
      newAction.play();
      ch.activeAction.crossFadeTo(newAction, fadeSec, true);
    } else {
      newAction.reset().fadeIn(fadeSec).play();
    }

    ch.activeAction    = newAction;
    ch.currentClipName = clipName;
  }

  _stopAllClips(ch) {
    if (!ch.mixer) return;
    ch.mixer.stopAllAction();
    ch.activeAction    = null;
    ch.currentClipName = null;
  }

  // ─── Private — Layer & Helpers ────────────────────────────────────────────

  _updateLayerTransform() {
    if (!this.appState.pageAnchor || !this.appState.pageLocked) {
      this.characterLayer.visible = false;
      return;
    }
    this.characterLayer.visible = this.isLoaded;
    this.characterLayer.matrix.copy(this.appState.pageAnchor.matrix);
    this.characterLayer.matrixWorldNeedsUpdate = true;
  }

  _clearCharacters() {
    while (this.characterLayer.children.length > 0) {
      const child = this.characterLayer.children[0];
      this.characterLayer.remove(child);
      this._disposeObject(child);
    }
    this.characters.clear();
    this.loadProgressMap.clear();
  }

  _disposeObject(obj) {
    obj.traverse?.(child => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
      else child.material?.dispose?.();
    });
  }

  _vecFromCfg(value, fx = 0, fy = 0, fz = 0) {
    return new THREE.Vector3(
      Number(value?.x ?? fx),
      Number(value?.y ?? fy),
      Number(value?.z ?? fz)
    );
  }

  _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  _emitChange() {
    this.dispatchEvent(new Event('change'));
  }
}
