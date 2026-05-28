import * as THREE from 'three';
import { clamp, round } from '../utils/math.js';

/**
 * BoundaryClamp keeps future character roots/footprints inside the page rectangle.
 * Coordinates are page-local: X/Z are constrained, Y stays on/above the page.
 */
export class BoundaryClamp {
  constructor({ pageAnchor, marginMeters = 0.025, footprintRadiusMeters = 0.025 }) {
    this.pageAnchor = pageAnchor;
    this.marginMeters = marginMeters;
    this.footprintRadiusMeters = footprintRadiusMeters;
    this.recompute();
  }

  recompute() {
    const safeInset = this.marginMeters + this.footprintRadiusMeters;
    const halfW = this.pageAnchor.widthMeters / 2;
    const halfH = this.pageAnchor.heightMeters / 2;

    this.limits = {
      minX: -halfW + safeInset,
      maxX: halfW - safeInset,
      minZ: -halfH + safeInset,
      maxZ: halfH - safeInset
    };

    if (this.limits.minX > this.limits.maxX) {
      this.limits.minX = 0;
      this.limits.maxX = 0;
    }

    if (this.limits.minZ > this.limits.maxZ) {
      this.limits.minZ = 0;
      this.limits.maxZ = 0;
    }
  }

  clampLocal(localPosition) {
    return new THREE.Vector3(
      clamp(localPosition.x, this.limits.minX, this.limits.maxX),
      localPosition.y,
      clamp(localPosition.z, this.limits.minZ, this.limits.maxZ)
    );
  }

  clampWorld(worldPosition) {
    const local = this.pageAnchor.worldToLocal(worldPosition);
    const clampedLocal = this.clampLocal(local);
    return this.pageAnchor.localToWorld(clampedLocal);
  }

  toJSON() {
    return {
      type: 'BoundaryClamp',
      pageId: this.pageAnchor.id,
      coordinateSpace: 'page-local',
      limits: {
        minX: round(this.limits.minX, 4),
        maxX: round(this.limits.maxX, 4),
        minZ: round(this.limits.minZ, 4),
        maxZ: round(this.limits.maxZ, 4)
      },
      marginMeters: round(this.marginMeters, 4),
      characterFootprintAware: true,
      footprintRadiusMeters: round(this.footprintRadiusMeters, 4)
    };
  }
}
