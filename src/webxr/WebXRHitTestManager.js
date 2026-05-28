/**
 * Minimal WebXR hit-test manager.
 *
 * Three.js owns the XRSession through renderer.xr.
 * This class requests a viewer-space hit-test source and updates a reticle matrix
 * every XR frame when a surface hit is available.
 */
export class WebXRHitTestManager {
  constructor({ renderer, reticle, onHitPose, onSessionChange, onError }) {
    this.renderer = renderer;
    this.reticle = reticle;
    this.onHitPose = onHitPose;
    this.onSessionChange = onSessionChange;
    this.onError = onError;

    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.surfaceLocked = false;

    this.handleSessionStart = this.handleSessionStart.bind(this);
    this.handleSessionEnd = this.handleSessionEnd.bind(this);

    this.renderer.xr.addEventListener('sessionstart', this.handleSessionStart);
    this.renderer.xr.addEventListener('sessionend', this.handleSessionEnd);
  }

  handleSessionStart() {
    this.hitTestSourceRequested = false;
    this.onSessionChange?.(true);
  }

  handleSessionEnd() {
    if (this.hitTestSource) {
      this.hitTestSource.cancel();
    }

    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.surfaceLocked = false;
    this.reticle.visible = false;
    this.onHitPose?.(null, false);
    this.onSessionChange?.(false);
  }

  setSurfaceLocked(locked) {
    this.surfaceLocked = locked;

    if (locked) {
      this.reticle.visible = false;
    }
  }

  async ensureHitTestSource(session) {
    if (this.hitTestSourceRequested) {
      return;
    }

    this.hitTestSourceRequested = true;

    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    } catch (error) {
      this.onError?.(error);
      this.reticle.visible = false;
      this.onHitPose?.(null, false);
    }
  }

  update(frame) {
    if (!frame) {
      return;
    }

    // Once the page plane is locked, stop updating the reticle/hit pose.
    // This prevents accidental plane changes and makes the placed page anchor stable
    // until the user explicitly presses Reset page.
    if (this.surfaceLocked) {
      this.reticle.visible = false;
      return;
    }

    const session = this.renderer.xr.getSession();
    if (!session) {
      this.reticle.visible = false;
      this.onHitPose?.(null, false);
      return;
    }

    this.ensureHitTestSource(session);

    if (!this.hitTestSource) {
      this.reticle.visible = false;
      this.onHitPose?.(null, false);
      return;
    }

    const referenceSpace = this.renderer.xr.getReferenceSpace();
    const hitTestResults = frame.getHitTestResults(this.hitTestSource);

    if (hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(referenceSpace);

      if (pose) {
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
        this.onHitPose?.(this.reticle.matrix, true);
        return;
      }
    }

    this.reticle.visible = false;
    this.onHitPose?.(null, false);
  }

  dispose() {
    this.renderer.xr.removeEventListener('sessionstart', this.handleSessionStart);
    this.renderer.xr.removeEventListener('sessionend', this.handleSessionEnd);

    if (this.hitTestSource) {
      this.hitTestSource.cancel();
    }
  }
}
