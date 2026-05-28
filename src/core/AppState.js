import * as THREE from 'three';
import { PageAnchor } from './PageAnchor.js';
import { BoundaryClamp } from './BoundaryClamp.js';
import { TrackingConfidence } from './TrackingConfidence.js';
import { matrixToArray, round, vectorToJSON } from '../utils/math.js';

/**
 * PAGE SIZE PRESETS — used by DebugPanel preset buttons.
 * All values in meters.
 */
export const PAGE_PRESETS = {
  'A4 Portrait':    { width: 0.210, height: 0.297 },
  'A4 Landscape':   { width: 0.297, height: 0.210 },
  'Book Page':      { width: 0.160, height: 0.240 },
  'US Letter':      { width: 0.216, height: 0.279 },
  'Square':         { width: 0.200, height: 0.200 }
};

export class AppState extends EventTarget {
  constructor() {
    super();

    this.defaultPageWidthMeters  = 0.210;
    this.defaultPageHeightMeters = 0.297;
    this.marginMeters            = 0.020;
    this.footprintRadiusMeters   = 0.025;

    this.isXRActive             = false;
    this.isCameraFallbackActive = false;
    this.hitVisible             = false;
    this.lastHitMatrix          = null;
    this.lastHitTimestampMs     = 0;

    this.pageAnchor             = null;
    this.boundaryClamp          = null;
    this.pageLocked             = false;
    this.pageLockedTimestampMs  = 0;
    this.actorLocalPosition     = new THREE.Vector3(0, 0.035, 0);

    this.trackingConfidence     = new TrackingConfidence();

    // Double-tap detection state.
    this._lastTapMs             = 0;
    this._doubleTapThresholdMs  = 400;
  }

  // ─── XR / Camera State ───────────────────────────────────────────────────

  setXRActive(active) {
    this.isXRActive = active;
    this.emitChange();
  }

  setCameraFallbackActive(active) {
    this.isCameraFallbackActive = active;
    this.emitChange();
  }

  setHitPose(matrix, visible) {
    this.hitVisible         = visible;
    this.lastHitMatrix      = visible && matrix ? matrix.clone() : this.lastHitMatrix;
    this.lastHitTimestampMs = visible ? performance.now() : this.lastHitTimestampMs;
    this.trackingConfidence.update({
      hitVisible:  this.hitVisible,
      pagePlaced:  Boolean(this.pageAnchor),
      pageLocked:  this.pageLocked
    });
    this.emitChange();
  }

  // ─── Double-Tap / Tap to Lock ─────────────────────────────────────────────

  /**
   * Call this from any tap/click handler.
   * Returns 'double' if this is a double-tap, 'single' otherwise.
   * This lets the WebXR select event and the HUD button both funnel through here.
   */
  recordTap() {
    const now = performance.now();
    const delta = now - this._lastTapMs;
    this._lastTapMs = now;
    return delta < this._doubleTapThresholdMs ? 'double' : 'single';
  }

  // ─── Page Placement ───────────────────────────────────────────────────────

  placePageFromCurrentHit() {
    if (this.pageLocked) {
      console.info('[AppState] Page already locked. Reset before placing again.');
      return false;
    }
    if (!this.lastHitMatrix) return false;

    this.pageAnchor = PageAnchor.fromPoseMatrix(this.lastHitMatrix, {
      widthMeters:  this.defaultPageWidthMeters,
      heightMeters: this.defaultPageHeightMeters,
      source: 'webxr-hit-test-locked'
    });

    this._lockPage('webxr');
    return true;
  }

  placeMockPage() {
    if (this.isXRActive) {
      console.warn('[AppState] Mock page is for desktop testing only.');
      return false;
    }
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, 0);
    this.lastHitMatrix = matrix.clone();
    this.hitVisible    = true;

    this.pageAnchor = PageAnchor.fromPoseMatrix(matrix, {
      widthMeters:  this.defaultPageWidthMeters,
      heightMeters: this.defaultPageHeightMeters,
      source: 'desktop-mock-locked'
    });

    this._lockPage('mock');
    return true;
  }

  /**
   * Place a mock page for camera-fallback mode.
   * The anchor sits in front of the camera at a fixed virtual distance.
   */
  placeFallbackPage() {
    const matrix = new THREE.Matrix4().makeTranslation(0, -0.05, -0.5);
    this.lastHitMatrix = matrix.clone();
    this.hitVisible    = true;

    this.pageAnchor = PageAnchor.fromPoseMatrix(matrix, {
      widthMeters:  this.defaultPageWidthMeters,
      heightMeters: this.defaultPageHeightMeters,
      source: 'camera-fallback-manual'
    });

    this._lockPage('fallback');
    return true;
  }

  _lockPage(source) {
    this.pageLocked             = true;
    this.pageLockedTimestampMs  = performance.now();
    this.rebuildClamp();
    this.actorLocalPosition.set(0, 0.035, 0);
    this.trackingConfidence.update({ hitVisible: true, pagePlaced: true, pageLocked: true });
    this.emitChange();
  }

  resetPage() {
    this.pageAnchor            = null;
    this.boundaryClamp         = null;
    this.pageLocked            = false;
    this.pageLockedTimestampMs = 0;
    this.actorLocalPosition.set(0, 0.035, 0);
    this.trackingConfidence.update({ hitVisible: this.hitVisible, pagePlaced: false, pageLocked: false });
    this.emitChange();
  }

  applyPagePreset(presetName) {
    const preset = PAGE_PRESETS[presetName];
    if (!preset) return false;

    this.defaultPageWidthMeters  = preset.width;
    this.defaultPageHeightMeters = preset.height;

    if (this.pageAnchor) {
      this.pageAnchor = this.pageAnchor.cloneWithSize(preset.width, preset.height);
      this.rebuildClamp();
      this.actorLocalPosition = this.boundaryClamp.clampLocal(this.actorLocalPosition);
    }

    this.emitChange();
    return true;
  }

  resizePage({ deltaWidth = 0, deltaHeight = 0 }) {
    if (!this.pageAnchor) return false;

    const width  = Math.max(0.08, this.pageAnchor.widthMeters  + deltaWidth);
    const height = Math.max(0.08, this.pageAnchor.heightMeters + deltaHeight);
    this.pageAnchor = this.pageAnchor.cloneWithSize(width, height);
    this.defaultPageWidthMeters  = width;
    this.defaultPageHeightMeters = height;

    this.rebuildClamp();
    this.actorLocalPosition = this.boundaryClamp.clampLocal(this.actorLocalPosition);
    this.emitChange();
    return true;
  }

  rebuildClamp() {
    if (!this.pageAnchor) { this.boundaryClamp = null; return; }
    this.boundaryClamp = new BoundaryClamp({
      pageAnchor:           this.pageAnchor,
      marginMeters:         this.marginMeters,
      footprintRadiusMeters: this.footprintRadiusMeters
    });
  }

  // ─── Debug Actor ──────────────────────────────────────────────────────────

  moveActorLocal(deltaX, deltaZ) {
    if (!this.boundaryClamp) return false;
    const next = this.actorLocalPosition.clone();
    next.x += deltaX;
    next.z += deltaZ;
    this.actorLocalPosition = this.boundaryClamp.clampLocal(next);
    this.emitChange();
    return true;
  }

  sendActorOutsideThenClamp() {
    if (!this.boundaryClamp || !this.pageAnchor) return false;
    const sx = Math.random() > 0.5 ? 1 : -1;
    const sz = Math.random() > 0.5 ? 1 : -1;
    const outside = new THREE.Vector3(sx * this.pageAnchor.widthMeters, 0.035, sz * this.pageAnchor.heightMeters);
    this.actorLocalPosition = this.boundaryClamp.clampLocal(outside);
    this.emitChange();
    return true;
  }

  getActorWorldPosition() {
    if (!this.pageAnchor) return null;
    return this.pageAnchor.localToWorld(this.actorLocalPosition);
  }

  // ─── Contracts JSON ───────────────────────────────────────────────────────

  getContracts() {
    const conf = this.trackingConfidence.getJSON();
    return {
      implementationDirection: 'Option A — WebXR-first MVP (v2)',
      timestampMs: round(performance.now(), 2),
      xrActive: this.isXRActive,
      cameraFallbackActive: this.isCameraFallbackActive,
      pageLocked: this.pageLocked,
      pageLockedTimestampMs: this.pageLocked ? round(this.pageLockedTimestampMs, 2) : null,
      latestHit: this.lastHitMatrix
        ? { visible: this.hitVisible, timestampMs: round(this.lastHitTimestampMs, 2), poseMatrix: matrixToArray(this.lastHitMatrix) }
        : null,
      detectedPlane: this.pageAnchor
        ? this.pageAnchor.toDetectedPlaneJSON({ confidence: conf.planeTracking.confidence, trackingState: conf.planeTracking.state })
        : null,
      pageBoundary: this.pageAnchor
        ? this.pageAnchor.toPageBoundaryJSON({ confidence: conf.pageDetection.confidence, status: conf.pageDetection.state })
        : null,
      pageCoordinateSystem: this.pageAnchor ? this.pageAnchor.toCoordinateSystemJSON() : null,
      boundaryClamp:        this.boundaryClamp ? this.boundaryClamp.toJSON() : null,
      debugActor: this.pageAnchor
        ? { localPosition: vectorToJSON(this.actorLocalPosition), worldPosition: vectorToJSON(this.getActorWorldPosition()), footprintRadiusMeters: round(this.footprintRadiusMeters, 4) }
        : null,
      trackingConfidence: conf
    };
  }

  emitChange() {
    this.dispatchEvent(new Event('change'));
  }
}
