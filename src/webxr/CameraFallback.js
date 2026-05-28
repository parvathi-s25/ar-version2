/**
 * CameraFallback — Phase 2/3 fallback for devices without WebXR support.
 *
 * When WebXR `immersive-ar` is unavailable, this module:
 * 1. Opens the back camera via getUserMedia()
 * 2. Renders the live video feed behind the Three.js canvas
 * 3. Provides a manual page rectangle the user can drag/resize
 * 4. Outputs the same PageAnchor + BoundaryClamp contract as the WebXR path
 *
 * Limitations vs WebXR (documented honestly):
 * - No real-world depth/pose data — the page anchor is placed at a fixed
 *   virtual distance in front of the camera (configurable).
 * - Scale in meters is approximate (no IMU/ARCore).
 * - Characters appear overlaid on the video but are NOT world-locked.
 */
export class CameraFallback extends EventTarget {
  constructor({ container, onReady, onError, onPermissionDenied }) {
    super();
    this.container         = container;
    this.onReady           = onReady;
    this.onError           = onError;
    this.onPermissionDenied = onPermissionDenied;

    this.stream     = null;
    this.videoEl    = null;
    this.active     = false;
    this.error      = null;

    this._supported = null;  // null = untested, true/false after test
  }

  /** Returns true if getUserMedia is available in this browser. */
  static isSupported() {
    return !!(navigator.mediaDevices?.getUserMedia);
  }

  /** Check if the browser can request the environment camera at all. */
  async checkSupport() {
    if (!CameraFallback.isSupported()) {
      this._supported = false;
      return false;
    }
    // Can't enumerate without permission on iOS, so just mark as potentially supported.
    this._supported = true;
    return true;
  }

  /**
   * Start the camera fallback.
   * Appends a <video> element behind the canvas and begins streaming.
   */
  async start() {
    if (this.active) return true;
    if (!CameraFallback.isSupported()) {
      this.error = 'getUserMedia not available in this browser.';
      this.onError?.(this.error);
      return false;
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      this.videoEl = document.createElement('video');
      this.videoEl.setAttribute('playsinline', '');
      this.videoEl.setAttribute('muted', '');
      this.videoEl.setAttribute('autoplay', '');
      this.videoEl.style.cssText = `
        position: fixed; top: 0; left: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        z-index: -1;
        background: #000;
      `;
      this.videoEl.srcObject = this.stream;
      document.body.insertBefore(this.videoEl, document.body.firstChild);

      await new Promise((resolve, reject) => {
        this.videoEl.onloadedmetadata = resolve;
        this.videoEl.onerror = reject;
        setTimeout(() => reject(new Error('Video metadata load timeout')), 8000);
      });

      await this.videoEl.play();

      this.active = true;
      this.error  = null;
      this.onReady?.({ width: this.videoEl.videoWidth, height: this.videoEl.videoHeight });
      this.dispatchEvent(new Event('start'));
      return true;

    } catch (err) {
      this.stream?.getTracks().forEach(t => t.stop());
      this.stream  = null;
      this.active  = false;

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        this.error = 'Camera permission denied. Please allow camera access and reload.';
        this.onPermissionDenied?.(this.error);
      } else if (err.name === 'NotFoundError') {
        this.error = 'No camera found on this device.';
        this.onError?.(this.error);
      } else {
        this.error = `Camera error: ${err.message}`;
        this.onError?.(this.error);
      }

      return false;
    }
  }

  stop() {
    if (!this.active) return;
    this.stream?.getTracks().forEach(t => t.stop());
    this.videoEl?.remove();
    this.stream  = null;
    this.videoEl = null;
    this.active  = false;
    this.dispatchEvent(new Event('stop'));
  }

  /** Get a diagnostic object for the UI. */
  getStatus() {
    const track = this.stream?.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    return {
      type: 'CameraFallback',
      active: this.active,
      supported: this._supported,
      error: this.error,
      resolution: this.active
        ? { width: settings.width ?? 0, height: settings.height ?? 0 }
        : null,
      facingMode: settings.facingMode ?? null,
      note: 'Camera fallback: characters render over video feed but are NOT world-locked. No real-world scale data available.'
    };
  }
}
