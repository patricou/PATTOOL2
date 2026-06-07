import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { ChemMolecule } from '../services/api.service';
import { COVALENT_RADII, CPK_COLORS, DEFAULT_COVALENT, DEFAULT_CPK } from './chem-data';

/**
 * Self-contained Three.js ball-and-stick viewer for a single molecule.
 * Each instance owns its own scene/renderer, so several can run at once
 * (e.g. side-by-side comparison).
 */
@Component({
  selector: 'app-molecule-viewer-3d',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <div class="mv3d-wrap" [style.height]="height">
      <div class="mv3d-controls" *ngIf="molecule?.has3d">
        <button type="button" class="btn btn-sm btn-dark" (click)="toggleAutoRotate()" [attr.aria-label]="'CHIMIE.VIEW_3D' | translate">
          <i class="fa" [ngClass]="autoRotateOn ? 'fa-pause' : 'fa-play'"></i>
        </button>
        <button type="button" class="btn btn-sm btn-dark" (click)="resetView()" aria-label="reset">
          <i class="fa fa-refresh"></i>
        </button>
      </div>
      <div #host class="mv3d-host" *ngIf="molecule?.has3d"></div>
      <div *ngIf="molecule && !molecule.has3d"
           class="mv3d-empty d-flex align-items-center justify-content-center text-muted small">
        {{ 'CHIMIE.NO_3D' | translate }}
      </div>
      <div *ngIf="!molecule"
           class="mv3d-empty d-flex align-items-center justify-content-center text-muted small">
        {{ 'CHIMIE.VIEWER_EMPTY' | translate }}
      </div>
    </div>
  `,
  styles: [`
    .mv3d-wrap {
      position: relative;
      width: 100%;
      border-radius: 10px;
      background: radial-gradient(circle at 50% 40%, #1a2238 0%, #0a0f1e 80%);
      overflow: hidden;
    }
    .mv3d-host { width: 100%; height: 100%; }
    .mv3d-empty {
      width: 100%;
      height: 100%;
      padding: 1rem;
      text-align: center;
      color: rgba(255, 255, 255, 0.7) !important;
    }
    .mv3d-controls {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 5;
      display: flex;
      gap: 4px;
    }
    .mv3d-controls .btn { opacity: 0.75; }
    .mv3d-controls .btn:hover { opacity: 1; }
  `]
})
export class MoleculeViewer3dComponent implements AfterViewInit, OnChanges, OnDestroy {

  @Input() molecule: ChemMolecule | null = null;
  @Input() height = '420px';

  @ViewChild('host') hostRef?: ElementRef<HTMLDivElement>;

  private viewReady = false;

  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
  private controls?: OrbitControls;
  private frameId = 0;
  private readonly disposables: { dispose: () => void }[] = [];
  private resizeObserver?: ResizeObserver;

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.rebuild();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['molecule'] && this.viewReady) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  get autoRotateOn(): boolean {
    return !!this.controls?.autoRotate;
  }

  toggleAutoRotate(): void {
    if (this.controls) {
      this.controls.autoRotate = !this.controls.autoRotate;
    }
  }

  resetView(): void {
    this.rebuild();
  }

  private rebuild(): void {
    // Wait a tick so the *ngIf host element exists for the current molecule state.
    setTimeout(() => this.buildScene(), 0);
  }

  private buildScene(): void {
    this.teardown();
    const mol = this.molecule;
    const container = this.hostRef?.nativeElement;
    if (!mol?.has3d || !mol.atoms?.length || !container) {
      return;
    }

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 420;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const group = new THREE.Group();
    scene.add(group);

    const positions = mol.atoms.map((a) => new THREE.Vector3(a.x, a.y, a.z));
    const centroid = new THREE.Vector3();
    positions.forEach((p) => centroid.add(p));
    centroid.multiplyScalar(1 / positions.length);
    positions.forEach((p) => p.sub(centroid));

    const sphereGeo = new THREE.SphereGeometry(1, 24, 24);
    this.disposables.push(sphereGeo);

    mol.atoms.forEach((atom, i) => {
      const color = CPK_COLORS[atom.symbol] ?? DEFAULT_CPK;
      const radius = Math.max(0.22, (COVALENT_RADII[atom.symbol] ?? DEFAULT_COVALENT) * 0.45);
      const material = new THREE.MeshPhongMaterial({ color, shininess: 90 });
      this.disposables.push(material);
      const mesh = new THREE.Mesh(sphereGeo, material);
      mesh.scale.setScalar(radius);
      mesh.position.copy(positions[i]);
      group.add(mesh);
    });

    mol.bonds.forEach((bond) => {
      const a = positions[bond.from];
      const b = positions[bond.to];
      if (!a || !b) {
        return;
      }
      const colorA = CPK_COLORS[mol.atoms[bond.from].symbol] ?? 0xcccccc;
      const colorB = CPK_COLORS[mol.atoms[bond.to].symbol] ?? 0xcccccc;
      this.addBond(group, a, b, colorA, colorB, bond.order);
    });

    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    const distance = radius * 2.2 + 3;
    camera.position.set(distance * 0.5, distance * 0.4, distance);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;

    this.observeResize(container);

    this.zone.runOutsideAngular(() => {
      const animate = () => {
        this.frameId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();
    });
  }

  private addBond(
    group: THREE.Group,
    a: THREE.Vector3,
    b: THREE.Vector3,
    colorA: number,
    colorB: number,
    order: number
  ): void {
    const direction = new THREE.Vector3().subVectors(b, a);
    const length = direction.length();
    if (length === 0) {
      return;
    }
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize());

    const perp = new THREE.Vector3();
    if (Math.abs(direction.y) < 0.99 * length) {
      perp.crossVectors(direction, up).normalize();
    } else {
      perp.crossVectors(direction, new THREE.Vector3(1, 0, 0)).normalize();
    }

    const count = Math.max(1, Math.min(3, order));
    const spacing = 0.16;
    const radius = count > 1 ? 0.065 : 0.09;
    const offsets =
      count === 1 ? [0] : count === 2 ? [-spacing / 2, spacing / 2] : [-spacing, 0, spacing];

    for (const offset of offsets) {
      const shift = perp.clone().multiplyScalar(offset);
      this.addBondHalf(group, a, mid, quat, length, radius, colorA, shift);
      this.addBondHalf(group, mid, b, quat, length, radius, colorB, shift);
    }
  }

  private addBondHalf(
    group: THREE.Group,
    start: THREE.Vector3,
    end: THREE.Vector3,
    quat: THREE.Quaternion,
    fullLength: number,
    radius: number,
    color: number,
    shift: THREE.Vector3
  ): void {
    const geo = new THREE.CylinderGeometry(radius, radius, fullLength / 2, 14, 1, true);
    this.disposables.push(geo);
    const material = new THREE.MeshPhongMaterial({ color, shininess: 60 });
    this.disposables.push(material);
    const mesh = new THREE.Mesh(geo, material);
    mesh.quaternion.copy(quat);
    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5).add(shift);
    mesh.position.copy(mid);
    group.add(mesh);
  }

  private observeResize(container: HTMLDivElement): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height || !this.renderer || !this.camera) {
        return;
      }
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
    this.resizeObserver.observe(container);
  }

  private teardown(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.controls?.dispose();
    this.controls = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    if (this.renderer) {
      this.renderer.dispose();
      const canvas = this.renderer.domElement;
      canvas.parentElement?.removeChild(canvas);
      this.renderer = undefined;
    }
    this.scene = undefined;
    this.camera = undefined;
  }
}
