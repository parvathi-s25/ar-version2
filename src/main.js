import './styles.css';

import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

import { AppState, PAGE_PRESETS } from './core/AppState.js';
import { WebXRHitTestManager } from './webxr/WebXRHitTestManager.js';
import { CameraFallback } from './webxr/CameraFallback.js';
import {
  createCamera, createDesktopGrid, createRenderer,
  createReticle, createScene, setReticleState
} from './render/SceneFactory.js';
import { DebugPageRenderer } from './render/DebugPageRenderer.js';
import { DebugPanel } from './ui/DebugPanel.js';
import { StoryRuntime } from './phase4/StoryRuntime.js';

class ARStorytellingApp {
  constructor() {
    this.container = document.querySelector('#app');
    this.uiRoot    = document.querySelector('#ui-root');

    this.state       = new AppState();
    this.scene       = createScene();
    this.camera      = createCamera();
    this.renderer    = createRenderer(this.container);
    this.clock       = new THREE.Clock();

    this.reticle     = createReticle();
    this.scene.add(this.reticle);

    this.desktopGrid = createDesktopGrid();
    this.scene.add(this.desktopGrid);

    this.debugPageRenderer = new DebugPageRenderer(this.scene);
    this.storyRuntime      = new StoryRuntime({ scene: this.scene, appState: this.state });

    this.cameraFallback = new CameraFallback({
      container: this.container,
      onReady: (info) => {
        console.info('[App] Camera fallback started:', info);
        this.state.setCameraFallbackActive(true);
      },
      onError: (msg) => {
        console.error('[App] Camera fallback error:', msg);
        this.state.setCameraFallbackActive(false);
      },
      onPermissionDenied: (msg) => {
        console.warn('[App] Camera permission denied:', msg);
        this.state.setCameraFallbackActive(false);
      }
    });

    this.hitTestManager = new WebXRHitTestManager({
      renderer: this.renderer,
      reticle:  this.reticle,
      onHitPose: (matrix, visible) => {
        this.state.setHitPose(matrix, visible);
        // Update reticle colour based on hit quality.
        setReticleState(this.reticle, visible ? 'ready' : 'scanning');
      },
      onSessionChange: (active) => {
        this.state.setXRActive(active);
        document.body.classList.toggle('xr-session-active', active);
        this.desktopGrid.visible = !active;
        this.hitTestManager.setSurfaceLocked(this.state.pageLocked);
      },
      onError: (error) => console.error('[App] WebXR hit-test error:', error)
    });

    // XR controller select = single-tap/double-tap handling.
    this.controller = this.renderer.xr.getController(0);
    this.controller.addEventListener('select', () => this._handleControllerTap());
    this.scene.add(this.controller);

    this._setupARButton();
    this._setupUI();
    this._setupEvents();
    this.renderer.setAnimationLoop((ts, frame) => this._animate(ts, frame));
  }

  // ─── AR Button ────────────────────────────────────────────────────────────

  _setupARButton() {
    if (!navigator.xr) {
      // WebXR completely unavailable — skip creating the button.
      return;
    }

    navigator.xr.isSessionSupported('immersive-ar').then(supported => {
      if (!supported) return;

      const button = ARButton.createButton(this.renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures:  ['dom-overlay', 'anchors', 'plane-detection'],
        domOverlay: { root: document.body }
      });
      button.id = 'ar-start-button';
      document.body.appendChild(button);
    }).catch(() => {});
  }

  // ─── UI ───────────────────────────────────────────────────────────────────

  _setupUI() {
    this.panel = new DebugPanel({
      root:           this.uiRoot,
      appState:       this.state,
      getPhase4Status: () => this.storyRuntime.getStatus(),
      getCameraFallbackStatus: () => this.cameraFallback.getStatus(),
      pagePresets:    Object.keys(PAGE_PRESETS),
      actions: {
        placePage:        () => this._placePage(),
        placeMockPage:    () => this._placeMockPage(),
        resetPage:        () => this._resetPage(),
        resizePage:       (args) => this.state.resizePage(args),
        applyPreset:      (name) => this.state.applyPagePreset(name),
        moveActor:        (dx, dz) => this.state.moveActorLocal(dx, dz),
        randomClamp:      () => this.state.sendActorOutsideThenClamp(),
        loadSampleStory:  () => this.storyRuntime.loadStory(),
        playStory:        () => this.storyRuntime.play(),
        pauseStory:       () => this.storyRuntime.pause(),
        restartStory:     () => this.storyRuntime.restart(),
        stopStory:        () => this.storyRuntime.stop(),
        startCameraFallback: () => this._startCameraFallback(),
        stopCameraFallback:  () => this._stopCameraFallback()
      }
    });
  }

  _setupEvents() {
    window.addEventListener('resize', () => this._onResize());
    this.state.addEventListener('change', () => this._updateDebugRenderers());
    this.storyRuntime.addEventListener('change', () => {
      this._updateDebugRenderers();
      this.panel?.render();
    });
  }

  // ─── Page Placement ───────────────────────────────────────────────────────

  _handleControllerTap() {
    // Double-tap = lock. Single-tap when already locked = ignore.
    const tapKind = this.state.recordTap();
    if (tapKind === 'double' || !this.state.pageLocked) {
      this._placePage();
    }
  }

  _placePage() {
    if (this.state.pageLocked) {
      console.info('[App] Page already locked — reset first.');
      return;
    }
    const placed = this.state.placePageFromCurrentHit();
    if (placed) {
      this.hitTestManager.setSurfaceLocked(true);
      setReticleState(this.reticle, 'locked');
    } else {
      console.warn('[App] No hit pose available yet. Move over a flat surface.');
    }
  }

  _resetPage() {
    this.state.resetPage();
    this.hitTestManager.setSurfaceLocked(false);
    setReticleState(this.reticle, 'scanning');
  }

  _placeMockPage() {
    if (this.renderer.xr.isPresenting) {
      console.warn('[App] Mock page is desktop-only.');
      return;
    }
    const placed = this.state.placeMockPage();
    if (placed) this.hitTestManager.setSurfaceLocked(true);
  }

  // ─── Camera Fallback ──────────────────────────────────────────────────────

  async _startCameraFallback() {
    if (this.renderer.xr.isPresenting) {
      console.warn('[App] Cannot start camera fallback while WebXR is presenting.');
      return;
    }
    const ok = await this.cameraFallback.start();
    if (ok) {
      // Auto-place a fallback page anchor so story can start immediately.
      this.state.placeFallbackPage();
    }
  }

  _stopCameraFallback() {
    this.cameraFallback.stop();
    this.state.setCameraFallbackActive(false);
    this.state.resetPage();
  }

  // ─── Render Loop ──────────────────────────────────────────────────────────

  _updateDebugRenderers() {
    this.debugPageRenderer.update({
      pageAnchor:           this.state.pageAnchor,
      boundaryClamp:        this.state.boundaryClamp,
      actorLocalPosition:   this.state.actorLocalPosition,
      footprintRadiusMeters: this.state.footprintRadiusMeters,
      showDebugActor:       !this.storyRuntime.hasLoadedCharacters()
    });
  }

  _animate(_ts, frame) {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (frame) this.hitTestManager.update(frame);
    this.storyRuntime.update(delta);
    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

new ARStorytellingApp();
