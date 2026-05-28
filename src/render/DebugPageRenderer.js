import * as THREE from 'three';

export class DebugPageRenderer {
  constructor(scene) {
    this.scene = scene;
    this.pageGroup = new THREE.Group();
    this.pageGroup.matrixAutoUpdate = false;
    this.pageGroup.visible = false;
    this.scene.add(this.pageGroup);

    this.pageMesh = null;
    this.pageEdges = null;
    this.clampEdges = null;
    this.actor = null;
    this.actorFootprint = null;
    this.cornerMarkers = [];

    this.currentWidth = 0;
    this.currentHeight = 0;
  }

  update({ pageAnchor, boundaryClamp, actorLocalPosition, footprintRadiusMeters, showDebugActor = true }) {
    if (!pageAnchor) {
      this.pageGroup.visible = false;
      return;
    }

    this.pageGroup.visible = true;
    this.pageGroup.matrix.copy(pageAnchor.matrix);
    this.pageGroup.matrixWorldNeedsUpdate = true;

    if (pageAnchor.widthMeters !== this.currentWidth || pageAnchor.heightMeters !== this.currentHeight) {
      this.rebuildPageGeometry(pageAnchor, boundaryClamp, footprintRadiusMeters);
    }

    if (this.actor) {
      this.actor.position.copy(actorLocalPosition);
      this.actor.visible = showDebugActor;
    }

    if (this.actorFootprint) {
      this.actorFootprint.position.set(actorLocalPosition.x, 0.003, actorLocalPosition.z);
      this.actorFootprint.visible = showDebugActor;
    }
  }

  rebuildPageGeometry(pageAnchor, boundaryClamp, footprintRadiusMeters) {
    this.clearPageChildren();

    this.currentWidth = pageAnchor.widthMeters;
    this.currentHeight = pageAnchor.heightMeters;

    const pageGeometry = new THREE.PlaneGeometry(pageAnchor.widthMeters, pageAnchor.heightMeters).rotateX(-Math.PI / 2);
    const pageMaterial = new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0.18,
      metalness: 0,
      roughness: 0.9,
      side: THREE.DoubleSide
    });

    this.pageMesh = new THREE.Mesh(pageGeometry, pageMaterial);
    this.pageMesh.renderOrder = 1;
    this.pageGroup.add(this.pageMesh);

    const edgeGeometry = new THREE.EdgesGeometry(pageGeometry);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x86efac, linewidth: 2 });
    this.pageEdges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    this.pageEdges.renderOrder = 2;
    this.pageGroup.add(this.pageEdges);

    if (boundaryClamp) {
      const clampW = Math.max(0.001, boundaryClamp.limits.maxX - boundaryClamp.limits.minX);
      const clampH = Math.max(0.001, boundaryClamp.limits.maxZ - boundaryClamp.limits.minZ);
      const clampCenterX = (boundaryClamp.limits.minX + boundaryClamp.limits.maxX) / 2;
      const clampCenterZ = (boundaryClamp.limits.minZ + boundaryClamp.limits.maxZ) / 2;

      const clampGeometry = new THREE.PlaneGeometry(clampW, clampH).rotateX(-Math.PI / 2);
      const clampEdgeGeometry = new THREE.EdgesGeometry(clampGeometry);
      const clampMaterial = new THREE.LineBasicMaterial({ color: 0xfacc15, linewidth: 2 });
      this.clampEdges = new THREE.LineSegments(clampEdgeGeometry, clampMaterial);
      this.clampEdges.position.set(clampCenterX, 0.004, clampCenterZ);
      this.pageGroup.add(this.clampEdges);
    }

    this.cornerMarkers = this.createCornerMarkers(pageAnchor);
    this.cornerMarkers.forEach((marker) => this.pageGroup.add(marker));

    this.actorFootprint = this.createActorFootprint(footprintRadiusMeters);
    this.pageGroup.add(this.actorFootprint);

    this.actor = this.createDebugActor();
    this.pageGroup.add(this.actor);
  }

  clearPageChildren() {
    while (this.pageGroup.children.length > 0) {
      const child = this.pageGroup.children.pop();
      this.disposeObject(child);
    }

    this.pageMesh = null;
    this.pageEdges = null;
    this.clampEdges = null;
    this.actor = null;
    this.actorFootprint = null;
    this.cornerMarkers = [];
  }

  createCornerMarkers(pageAnchor) {
    const corners = pageAnchor.getLocalCorners();
    const positions = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];

    return positions.map((position) => {
      const geometry = new THREE.SphereGeometry(0.009, 16, 16);
      const material = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.45 });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.copy(position);
      marker.position.y = 0.012;
      return marker;
    });
  }

  createActorFootprint(radius) {
    const geometry = new THREE.CylinderGeometry(radius, radius, 0.004, 32);
    const material = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.003;
    return mesh;
  }

  createDebugActor() {
    const group = new THREE.Group();

    const bodyGeometry = new THREE.CapsuleGeometry(0.018, 0.05, 6, 14);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.055;
    group.add(body);

    const headGeometry = new THREE.SphereGeometry(0.018, 18, 18);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 0.105;
    group.add(head);

    group.position.set(0, 0.035, 0);
    return group;
  }

  disposeObject(object) {
    object.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    });
  }
}
