import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { PoseFrame } from '../types';
import { POSE_CONNECTIONS } from '../lib/pose';

type ThreePreviewProps = {
  frame?: PoseFrame;
};

export function ThreePreview({ frame }: ThreePreviewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const jointsRef = useRef<THREE.Mesh[]>([]);
  const linesRef = useRef<THREE.LineSegments | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x050708, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    camera.position.set(0, 0.5, 5.8);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x20333a, 2));

    const grid = new THREE.GridHelper(4, 8, 0x2a3a3e, 0x172124);
    grid.position.y = -1.25;
    scene.add(grid);

    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x8ff5ff,
      emissive: 0x0b3d44,
      roughness: 0.35
    });
    const joints = Array.from({ length: 33 }, () => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), jointMaterial);
      scene.add(mesh);
      return mesh;
    });

    const lineGeometry = new THREE.BufferGeometry();
    const linePositions = new Float32Array(POSE_CONNECTIONS.length * 2 * 3);
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: 0xf5d76e, linewidth: 2 })
    );
    scene.add(lines);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    jointsRef.current = joints;
    linesRef.current = lines;

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(220, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    return () => {
      observer.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    renderFrame(frame, jointsRef.current, linesRef.current, sceneRef.current, cameraRef.current, rendererRef.current);
  }, [frame]);

  return <div ref={mountRef} className="three-preview" />;
}

function renderFrame(
  frame: PoseFrame | undefined,
  joints: THREE.Mesh[],
  lines: THREE.LineSegments | null,
  scene: THREE.Scene | null,
  camera: THREE.PerspectiveCamera | null,
  renderer: THREE.WebGLRenderer | null
) {
  if (!scene || !camera || !renderer || !lines) return;
  const points = frame?.worldLandmarks?.length ? frame.worldLandmarks : frame?.landmarks || [];
  const mapped = points.map((point) => {
    if (frame?.worldLandmarks?.length) {
      return new THREE.Vector3(point.x * 2.5, -point.y * 2.5, -point.z * 2.5);
    }
    return new THREE.Vector3((point.x - 0.5) * 3, -(point.y - 0.5) * 2.8, -point.z * 4);
  });

  joints.forEach((joint, index) => {
    const point = mapped[index];
    joint.visible = Boolean(point);
    if (point) joint.position.copy(point);
  });

  const positions = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
  let cursor = 0;
  for (const [from, to] of POSE_CONNECTIONS) {
    const a = mapped[from] || new THREE.Vector3();
    const b = mapped[to] || new THREE.Vector3();
    positions.setXYZ(cursor, a.x, a.y, a.z);
    positions.setXYZ(cursor + 1, b.x, b.y, b.z);
    cursor += 2;
  }
  positions.needsUpdate = true;
  lines.visible = mapped.length > 0;
  renderer.render(scene, camera);
}
