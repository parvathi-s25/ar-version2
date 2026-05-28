import * as THREE from 'three';
import { getMatrixAxes, getMatrixPosition, matrixToArray, round, vectorToJSON } from '../utils/math.js';

/**
 * PageAnchor represents the detected/placed physical page in WebXR world space.
 *
 * Local coordinate convention:
 * - +X: page width direction
 * - +Z: page height/depth direction
 * - +Y: page normal, out of the page
 * - page surface is local Y = 0
 */
export class PageAnchor {
  constructor({ id = crypto.randomUUID(), poseMatrix, widthMeters = 0.28, heightMeters = 0.38, source = 'webxr-hit-test' }) {
    this.id = id;
    this.timestampMs = performance.now();
    this.matrix = poseMatrix.clone();
    this.inverseMatrix = poseMatrix.clone().invert();
    this.widthMeters = widthMeters;
    this.heightMeters = heightMeters;
    this.source = source;
  }

  static fromPoseMatrix(poseMatrix, options = {}) {
    return new PageAnchor({
      poseMatrix,
      widthMeters: options.widthMeters ?? 0.28,
      heightMeters: options.heightMeters ?? 0.38,
      source: options.source ?? 'webxr-hit-test'
    });
  }

  cloneWithSize(widthMeters, heightMeters) {
    return new PageAnchor({
      id: this.id,
      poseMatrix: this.matrix,
      widthMeters,
      heightMeters,
      source: this.source
    });
  }

  get originWorld() {
    return getMatrixPosition(this.matrix);
  }

  get axesWorld() {
    return getMatrixAxes(this.matrix);
  }

  localToWorld(localVector) {
    return localVector.clone().applyMatrix4(this.matrix);
  }

  worldToLocal(worldVector) {
    return worldVector.clone().applyMatrix4(this.inverseMatrix);
  }

  getLocalCorners() {
    const halfW = this.widthMeters / 2;
    const halfH = this.heightMeters / 2;

    return {
      topLeft: new THREE.Vector3(-halfW, 0, -halfH),
      topRight: new THREE.Vector3(halfW, 0, -halfH),
      bottomRight: new THREE.Vector3(halfW, 0, halfH),
      bottomLeft: new THREE.Vector3(-halfW, 0, halfH)
    };
  }

  getWorldCorners() {
    const local = this.getLocalCorners();

    return {
      topLeft: this.localToWorld(local.topLeft),
      topRight: this.localToWorld(local.topRight),
      bottomRight: this.localToWorld(local.bottomRight),
      bottomLeft: this.localToWorld(local.bottomLeft)
    };
  }

  toDetectedPlaneJSON({ confidence = 0.75, trackingState = 'tracking' } = {}) {
    const axes = this.axesWorld;

    return {
      type: 'DetectedPlane',
      id: `plane_${this.id}`,
      timestampMs: round(this.timestampMs, 2),
      source: this.source,
      classification: 'placed-horizontal-or-surface-aligned',
      poseMatrix: matrixToArray(this.matrix),
      normalWorld: vectorToJSON(axes.yAxis),
      confidence: round(confidence, 2),
      trackingState
    };
  }

  toPageBoundaryJSON({ confidence = 0.7, status = 'placed' } = {}) {
    const worldCorners = this.getWorldCorners();

    return {
      type: 'PageBoundary',
      id: this.id,
      timestampMs: round(this.timestampMs, 2),
      detectionMode: 'webxr-hit-test-placed-rectangle',
      imageSize: null,
      cornersPx: null,
      note: 'Option A does not run OpenCV/Canny yet; this boundary is a placed page rectangle on the WebXR hit-test plane.',
      cornersWorld: {
        topLeft: vectorToJSON(worldCorners.topLeft),
        topRight: vectorToJSON(worldCorners.topRight),
        bottomRight: vectorToJSON(worldCorners.bottomRight),
        bottomLeft: vectorToJSON(worldCorners.bottomLeft)
      },
      confidence: round(confidence, 2),
      status
    };
  }

  toCoordinateSystemJSON() {
    const axes = this.axesWorld;

    return {
      type: 'PageCoordinateSystem',
      id: `page_space_${this.id}`,
      originWorld: vectorToJSON(this.originWorld),
      axesWorld: {
        xAxis: vectorToJSON(axes.xAxis),
        yAxis: vectorToJSON(axes.yAxis),
        zAxis: vectorToJSON(axes.zAxis)
      },
      sizeMeters: {
        width: round(this.widthMeters, 4),
        height: round(this.heightMeters, 4)
      },
      localPlane: 'X-Z',
      unit: 'meters'
    };
  }
}
