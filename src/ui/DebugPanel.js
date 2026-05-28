/**
 * DebugPanel v2
 * 
 * New in v2:
 * - Page size presets dropdown
 * - Camera fallback section for non-WebXR devices
 * - WebXR compatibility diagnostics (specific failure reason)
 * - Onboarding instruction card
 * - Character load progress bars
 * - Multi-character status rows
 * - Cleaner AR HUD with story progress indicator
 * - All buttons use data-action; no inline onclick
 */

const _esc = (v) =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export class DebugPanel {
  constructor({ root, appState, getPhase4Status, getCameraFallbackStatus, pagePresets = [], actions }) {
    this.root                   = root;
    this.appState               = appState;
    this.getPhase4Status        = getPhase4Status;
    this.getCameraFallbackStatus = getCameraFallbackStatus;
    this.pagePresets            = pagePresets;
    this.actions                = actions;
    this.forceDebugOpenInAR     = false;
    this._webxrDiag             = null;  // cached WebXR diagnostic string

    this.container = document.createElement('section');
    this.container.className = 'debug-panel';
    this.root.appendChild(this.container);

    this.arHud = document.createElement('section');
    this.arHud.className = 'ar-hud';
    this.root.appendChild(this.arHud);

    // Run WebXR diagnostics once.
    this._runWebXRDiagnostics();

    this.appState.addEventListener('change', () => this.render());
    this.render();
  }

  async _runWebXRDiagnostics() {
    if (!window.isSecureContext) {
      this._webxrDiag = 'HTTPS required for WebXR. Open via https:// URL.';
      this.render(); return;
    }
    if (!navigator.xr) {
      this._webxrDiag = 'navigator.xr not available. Use Chrome on Android with ARCore, or Safari 16+ on iOS.';
      this.render(); return;
    }
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      if (!supported) {
        this._webxrDiag = 'immersive-ar not supported. Install Google Play Services for AR, or update Chrome.';
      } else {
        this._webxrDiag = null;  // supported — no warning needed
      }
    } catch {
      this._webxrDiag = 'WebXR support check failed. Device may lack required sensors.';
    }
    this.render();
  }

  render() {
    const contracts  = this.appState.getContracts();
    const phase4     = this.getPhase4Status?.() ?? null;
    const camStatus  = this.getCameraFallbackStatus?.() ?? null;
    const confidence = contracts.trackingConfidence;
    const hasPage    = Boolean(contracts.pageBoundary);
    const locked     = Boolean(contracts.pageLocked);
    const canPlace   = Boolean(this.appState.lastHitMatrix) && !locked;
    const xrActive   = Boolean(contracts.xrActive);
    const camActive  = Boolean(contracts.cameraFallbackActive);
    const hidePanel  = xrActive && !this.forceDebugOpenInAR;

    this.container.classList.toggle('is-hidden-in-ar', hidePanel);
    this._renderFullPanel({ contracts, phase4, camStatus, confidence, hasPage, locked, canPlace, xrActive, camActive });
    this._renderARHud({ contracts, phase4, confidence, hasPage, locked, canPlace, xrActive });
  }

  _renderFullPanel({ contracts, phase4, camStatus, confidence, hasPage, locked, canPlace, xrActive, camActive }) {
    const storyLoaded    = Boolean(phase4?.loaded);
    const storyLoading   = Boolean(phase4?.loading);
    const storyPlaying   = Boolean(phase4?.playing);
    const storyReady     = storyLoaded && locked;
    const webxrUnavail   = Boolean(this._webxrDiag);
    const currentPreset  = this.appState.defaultPageWidthMeters;

    // Compatibility warning block.
    const compatBlock = webxrUnavail ? `
      <div class="compat-warning">
        <strong>⚠ WebXR AR Unavailable</strong>
        <span>${_esc(this._webxrDiag)}</span>
        ${camStatus?.supported !== false ? `<button data-action="startCamFallback" ${camActive ? 'disabled' : ''}>
          ${camActive ? '📷 Camera active' : '📷 Use camera fallback'}
        </button>` : '<span class="note">getUserMedia also unavailable on this device.</span>'}
      </div>` : '';

    // AR active warning.
    const arWarning = xrActive && !this.forceDebugOpenInAR ? '' : (xrActive ? `
      <div class="ar-panel-warning">
        <strong>AR session active</strong>
        <span>This panel covers the camera view.</span>
        <button data-action="hidePanel" class="secondary">Hide panel</button>
      </div>` : '');

    // Camera fallback info.
    const camBlock = camActive ? `
      <div class="cam-fallback-info">
        <strong>📷 Camera fallback active</strong>
        <span>Characters render over live video. No real-world scale. 
        Resolution: ${camStatus?.resolution?.width ?? '?'}×${camStatus?.resolution?.height ?? '?'}
        · Facing: ${camStatus?.facingMode ?? 'unknown'}</span>
        <button data-action="stopCamFallback" class="danger secondary">Stop camera</button>
      </div>` : '';

    // Onboarding.
    const onboarding = !hasPage ? `
      <div class="onboarding-card">
        <strong>${xrActive ? '👋 How to place your page' : '👋 Getting started'}</strong>
        <ol>
          ${xrActive
            ? '<li>Point your phone at a flat surface (table, book).</li><li>Wait for the blue reticle to appear.</li><li>Tap once to lock the page — or double-tap to re-lock.</li><li>Press Play to start the story.</li>'
            : camActive
              ? '<li>Point camera at your book/page.</li><li>The page anchor has been auto-placed.</li><li>Load a story and press Play.</li>'
              : '<li>Click <strong>Mock place page</strong> to test on desktop.</li><li>Or open this URL on a supported Android phone.</li>'
          }
        </ol>
      </div>` : '';

    // Page size presets.
    const presetsHtml = this.pagePresets.map(name =>
      `<button data-action="preset" data-preset="${_esc(name)}" class="secondary preset-btn">${_esc(name)}</button>`
    ).join('');

    // Character list for Phase 4.
    const charRows = (phase4?.characters ?? []).map(ch => `
      <div class="char-row ${ch.loadError ? 'char-error' : ''}">
        <span class="char-name">${_esc(ch.displayName ?? ch.id)}</span>
        <span class="char-meta">${ch.loadedFromAsset ? '✓ GLB' : '⚠ fallback'} · ${_esc(ch.currentClip ?? 'idle')}</span>
        ${ch.loadProgress < 1 ? `<div class="progress-bar"><div class="progress-fill" style="width:${Math.round(ch.loadProgress * 100)}%"></div></div>` : ''}
        ${ch.loadError ? `<span class="char-err-msg">${_esc(ch.loadError)}</span>` : ''}
      </div>`).join('');

    // Available clips for all characters.
    const allClips = (phase4?.characters ?? []).flatMap(c => c.animationClips ?? []);
    const clipsInfo = allClips.length > 0
      ? `<p class="meta-note">Animation clips: ${_esc(allClips.join(', '))}</p>`
      : '';

    const storyProgress = storyLoaded
      ? Math.round((phase4.currentTimeMs / Math.max(1, phase4.durationMs)) * 100)
      : 0;

    this.container.innerHTML = `
      <h1>AR Storytelling MVP</h1>
      <p class="subtitle">WebXR hit-test · Page-local boundary clamp · GLTF story runtime</p>

      ${arWarning}
      ${compatBlock}
      ${camBlock}
      ${onboarding}

      <div class="status-grid">
        <div class="status-card">
          <span>Mode</span>
          <strong>${xrActive ? 'WebXR AR' : camActive ? 'Camera' : 'Desktop mock'}</strong>
        </div>
        <div class="status-card">
          <span>Tracking</span>
          <strong>${locked ? '🔒 locked' : contracts.latestHit?.visible ? '👁 visible' : '⏳ scan'}</strong>
        </div>
        <div class="status-card">
          <span>Page</span>
          <strong>${hasPage ? (locked ? 'locked ✓' : 'placed') : 'not placed'}</strong>
        </div>
        <div class="status-card">
          <span>Confidence</span>
          <strong>${confidence.overall.state} · ${confidence.overall.confidence}</strong>
        </div>
      </div>

      <div class="button-row">
        <button data-action="place" ${canPlace ? '' : 'disabled'}>${locked ? 'Page locked' : 'Lock page (tap)'}</button>
        <button data-action="mock" class="secondary" ${xrActive || camActive ? 'disabled' : ''}>Mock place</button>
        <button data-action="reset" class="danger" ${hasPage ? '' : 'disabled'}>Reset page</button>
      </div>

      <details class="section-details" ${hasPage ? '' : 'open'}>
        <summary>Page size</summary>
        <div class="button-row resize-row">
          <button data-action="widthMinus"  ${hasPage ? '' : 'disabled'}>W −</button>
          <button data-action="widthPlus"   ${hasPage ? '' : 'disabled'}>W +</button>
          <button data-action="heightMinus" ${hasPage ? '' : 'disabled'}>H −</button>
          <button data-action="heightPlus"  ${hasPage ? '' : 'disabled'}>H +</button>
        </div>
        <div class="preset-row">${presetsHtml}</div>
        <p class="meta-note">Current: ${(this.appState.defaultPageWidthMeters * 100).toFixed(0)} × ${(this.appState.defaultPageHeightMeters * 100).toFixed(0)} cm</p>
      </details>

      <section class="phase4-panel">
        <h2>Story runtime — Phase 4</h2>

        <div class="status-grid compact">
          <div class="status-card">
            <span>Story</span>
            <strong>${storyLoading ? '⏳ loading' : storyLoaded ? '✓ loaded' : '—'}</strong>
          </div>
          <div class="status-card">
            <span>Playback</span>
            <strong>${storyPlaying ? '▶ playing' : '⏸ paused'}</strong>
          </div>
          <div class="status-card">
            <span>Time</span>
            <strong>${phase4 ? `${Math.round(phase4.currentTimeMs)}ms` : '—'}</strong>
          </div>
          <div class="status-card">
            <span>Characters</span>
            <strong>${phase4?.characters?.length ?? 0}</strong>
          </div>
        </div>

        ${storyLoaded ? `
          <div class="progress-bar story-progress" title="${storyProgress}%">
            <div class="progress-fill" style="width:${storyProgress}%"></div>
          </div>` : ''}

        <div class="button-row">
          <button data-action="loadSampleStory" ${storyLoading ? 'disabled' : ''}>Load story</button>
          <button data-action="playStory"    ${storyReady ? '' : 'disabled'}>▶ Play</button>
          <button data-action="pauseStory"   ${storyLoaded ? '' : 'disabled'} class="secondary">⏸ Pause</button>
          <button data-action="restartStory" ${storyReady ? '' : 'disabled'} class="secondary">↺ Restart</button>
          <button data-action="stopStory"    ${storyLoaded ? '' : 'disabled'} class="secondary">■ Stop</button>
        </div>

        ${!locked && !camActive ? '<p class="warning-note">Lock the page first before playing.</p>' : ''}
        ${phase4?.lastError ? `<p class="warning-note">Error: ${_esc(phase4.lastError)}</p>` : ''}

        ${charRows ? `<div class="char-list">${charRows}</div>` : ''}
        ${clipsInfo}
      </section>

      <details class="section-details">
        <summary>Debug actor controls</summary>
        <div class="control-grid">
          <button data-action="moveLeft"     ${hasPage ? '' : 'disabled'}>← X</button>
          <button data-action="moveForward"  ${hasPage ? '' : 'disabled'}>↑ Z</button>
          <button data-action="moveBackward" ${hasPage ? '' : 'disabled'}>↓ Z</button>
          <button data-action="moveRight"    ${hasPage ? '' : 'disabled'}>X →</button>
        </div>
        <div class="button-row">
          <button data-action="randomClamp" ${hasPage ? '' : 'disabled'}>Send outside + clamp</button>
        </div>
      </details>

      <div class="button-row">
        <button data-action="copyJson" class="secondary">Copy JSON</button>
      </div>

      <details class="json-details" open>
        <summary>Phase 2/3 contracts</summary>
        <pre class="json-box">${_esc(JSON.stringify(contracts, null, 2))}</pre>
      </details>

      <details class="json-details">
        <summary>Phase 4 runtime</summary>
        <pre class="json-box">${_esc(JSON.stringify(phase4, null, 2))}</pre>
      </details>
    `;

    this.container.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => this._handleAction(btn.dataset.action, btn.dataset));
    });
  }

  _renderARHud({ contracts, phase4, confidence, hasPage, locked, canPlace, xrActive }) {
    this.arHud.classList.toggle('is-visible', xrActive && !this.forceDebugOpenInAR);

    if (!xrActive || this.forceDebugOpenInAR) {
      this.arHud.innerHTML = '';
      return;
    }

    const hitLabel   = locked ? '🔒 locked' : contracts.latestHit?.visible ? '👁 hit visible' : '⏳ scan surface';
    const storyLabel = phase4?.loaded
      ? (phase4.playing ? `▶ ${Math.round((phase4.currentTimeMs / Math.max(1, phase4.durationMs)) * 100)}%` : '⏸ ready')
      : '— no story';

    this.arHud.innerHTML = `
      <div class="ar-hud__text">
        <strong>AR active · ${confidence.overall.state}</strong>
        <span>${hitLabel} · ${storyLabel}</span>
      </div>
      <div class="ar-hud__actions">
        <button data-ar-action="place" ${canPlace ? '' : 'disabled'}>${locked ? '🔒' : 'Lock'}</button>
        <button data-ar-action="storyToggle" ${phase4?.loaded && locked ? '' : 'disabled'}>
          ${phase4?.playing ? '⏸' : '▶'}
        </button>
        <button data-ar-action="reset" class="secondary" ${hasPage ? '' : 'disabled'}>↺</button>
        <button data-ar-action="showDebug" class="secondary">⚙</button>
      </div>
    `;

    this.arHud.querySelectorAll('button[data-ar-action]').forEach(btn => {
      btn.addEventListener('click', () => this._handleARHudAction(btn.dataset.arAction));
    });
  }

  async _handleAction(action, dataset = {}) {
    switch (action) {
      case 'place':         this.actions.placePage();               break;
      case 'mock':          this.actions.placeMockPage();           break;
      case 'reset':         this.actions.resetPage();               break;
      case 'widthMinus':    this.actions.resizePage({ deltaWidth: -0.02 });  break;
      case 'widthPlus':     this.actions.resizePage({ deltaWidth:  0.02 });  break;
      case 'heightMinus':   this.actions.resizePage({ deltaHeight: -0.02 }); break;
      case 'heightPlus':    this.actions.resizePage({ deltaHeight:  0.02 }); break;
      case 'preset':        this.actions.applyPreset(dataset.preset);        break;
      case 'moveLeft':      this.actions.moveActor(-0.025, 0);      break;
      case 'moveRight':     this.actions.moveActor( 0.025, 0);      break;
      case 'moveForward':   this.actions.moveActor(0, -0.025);      break;
      case 'moveBackward':  this.actions.moveActor(0,  0.025);      break;
      case 'randomClamp':   this.actions.randomClamp();             break;
      case 'loadSampleStory': await this.actions.loadSampleStory(); break;
      case 'playStory':     this.actions.playStory();               break;
      case 'pauseStory':    this.actions.pauseStory();              break;
      case 'restartStory':  this.actions.restartStory();            break;
      case 'stopStory':     this.actions.stopStory();               break;
      case 'startCamFallback': await this.actions.startCameraFallback(); break;
      case 'stopCamFallback':  this.actions.stopCameraFallback();   break;
      case 'copyJson':      await this._copyContracts();            break;
      case 'hidePanel':
        this.forceDebugOpenInAR = false;
        this.render();
        break;
    }
  }

  _handleARHudAction(action) {
    switch (action) {
      case 'place':   this.actions.placePage();  break;
      case 'reset':   this.actions.resetPage();  break;
      case 'storyToggle': {
        const p = this.getPhase4Status?.();
        if (p?.playing) this.actions.pauseStory(); else this.actions.playStory();
        break;
      }
      case 'showDebug':
        this.forceDebugOpenInAR = true;
        this.render();
        break;
    }
  }

  async _copyContracts() {
    const payload = {
      phase23: this.appState.getContracts(),
      phase4:  this.getPhase4Status?.() ?? null
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      console.warn('[DebugPanel] Clipboard copy failed (requires HTTPS + user gesture).');
    }
  }
}
