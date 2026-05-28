import * as THREE from 'three';

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function vectorToJSON(vector, digits = 4) {
  return {
    x: round(vector.x, digits),
    y: round(vector.y, digits),
    z: round(vector.z, digits)
  };
}

export function matrixToArray(matrix, digits = 5) {
  return matrix.elements.map((value) => round(value, digits));
}

export function getMatrixAxes(matrix) {
  const e = matrix.elements;

  return {
    xAxis: new THREE.Vector3(e[0], e[1], e[2]).normalize(),
    yAxis: new THREE.Vector3(e[4], e[5], e[6]).normalize(),
    zAxis: new THREE.Vector3(e[8], e[9], e[10]).normalize()
  };
}

export function getMatrixPosition(matrix) {
  const position = new THREE.Vector3();
  position.setFromMatrixPosition(matrix);
  return position;
}

export function makePoseMatrixFromPosition(position, target = new THREE.Vector3(0, 0, 0)) {
  const matrix = new THREE.Matrix4();
  const object = new THREE.Object3D();
  object.position.copy(position);
  object.lookAt(target);
  object.updateMatrix();
  matrix.copy(object.matrix);
  return matrix;
}
