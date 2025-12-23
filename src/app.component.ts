import { Component, ChangeDetectionStrategy, ElementRef, viewChild, AfterViewInit, OnDestroy, signal, computed } from '@angular/core';

declare const THREE: any;
declare const Hands: any;
declare const Camera: any;

interface CelestialBody {
  mesh: any;
  velocity: any;
  rotationSpeed: any;
  baseOpacity: number;
  noiseOffset: number;
  hitHighlight: number; 
  baseScale: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:resize)': 'onWindowResize()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    '(wheel)': 'onWheel($event)'
  }
})
export class AppComponent implements AfterViewInit, OnDestroy {
  canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('rendererCanvas');
  videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('videoElement');

  // State signals
  isCameraActive = signal(false);
  isHandDetected = signal(false);
  isShuttingDown = signal(false);
  activeFingers = signal(0);
  isLoadingCamera = signal(false);
  appVersion = signal('v6.0.0 RESPONSIVE');

  // UI status
  controlStatus = computed(() => {
    if (this.isShuttingDown()) return 'Đang trả về trạng thái gốc...';
    if (!this.isHandDetected()) return 'Đang quét không gian...';
    if (this.activeFingers() >= 4) return 'Kết nối: Ổn định';
    return 'Xòe bàn tay để kích hoạt';
  });

  private scene: any;
  private camera: any;
  private renderer: any;
  private particleSphere: any;
  private worldMapMesh: any;
  private celestialGroup: any;
  private celestialBodies: CelestialBody[] = [];
  private animationFrameId: number | null = null;
  private clock = new THREE.Clock();

  // Interaction State
  private pointers = new Map<number, { x: number, y: number }>();
  private lastPinchDistance = 0;
  private isDragging = false;
  private previousPointerPosition = { x: 0, y: 0 };
  
  // Physics Constants
  private rotationVelocity = new THREE.Quaternion(0, 0, 0, 1); 
  private readonly rotationDrag = 0.18; 
  private zoomVelocity = 0;
  private readonly zoomDampingFactor = 0.8;
  
  // Globe Scale Management
  private baseGlobeScale = 1.0; // Sẽ được tính lại dựa trên màn hình
  private currentGlobeScale = 1.0;
  private targetGlobeScale = 1.0;
  private readonly minScale = 0.3; 
  private readonly maxScale = 2.5; 

  // Hand Tracking Precision
  private hands: any;
  private mediaPipeCamera: any;
  private smoothedHandPos = { x: 0.5, y: 0.5 };
  private smoothedSpread = 0;
  private readonly smoothingAlpha = 0.05; 
  private readonly rotationDeadZone = 0.0015; 

  // Shader Uniforms
  private shaderUniforms = {
    uTime: { value: 0 },
    uScale: { value: 1.0 },
    uOpacity: { value: 0.25 }
  };

  ngAfterViewInit(): void {
    if (typeof THREE === 'undefined') return;
    this.updateBaseScale();
    this.initThreeJs();
    this.animate();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    if (this.mediaPipeCamera) this.mediaPipeCamera.stop();
  }

  private updateBaseScale(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Nếu màn hình dọc (Portrait), giảm kích thước ban đầu xuống 0.85
    this.baseGlobeScale = height > width ? 0.82 : 1.0;
    
    // Nếu là lần đầu chạy, set target bằng base
    if (this.currentGlobeScale === 1.0 && !this.isCameraActive()) {
      this.targetGlobeScale = this.baseGlobeScale;
      this.currentGlobeScale = this.baseGlobeScale;
    }
  }

  private initThreeJs(): void {
    const canvas = this.canvasRef().nativeElement;
    this.scene = new THREE.Scene();
    
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.z = 18;

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const textureLoader = new THREE.TextureLoader();
    const mapTexture = textureLoader.load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_lights_2048.png');
    mapTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    
    const mapMaterial = new THREE.MeshBasicMaterial({
      map: mapTexture,
      color: 0xffff33, 
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mapGeometry = new THREE.SphereGeometry(4.5, 96, 48);
    this.worldMapMesh = new THREE.Mesh(mapGeometry, mapMaterial);
    this.scene.add(this.worldMapMesh);

    const particleCount = 2000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const radius = 4.1;

    for (let i = 0; i < particleCount; i++) {
      const phi = Math.acos(-1 + (2 * i) / particleCount);
      const theta = Math.sqrt(particleCount * Math.PI) * phi;
      positions[i * 3] = radius * Math.cos(theta) * Math.sin(phi);
      positions[i * 3 + 1] = radius * Math.sin(theta) * Math.sin(phi);
      positions[i * 3 + 2] = radius * Math.cos(phi);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const vertexShader = `
      uniform float uTime;
      uniform float uScale;
      void main() {
        vec3 pos = position;
        float pulse = 1.0 + sin(uTime * 1.5 + position.y * 0.5) * 0.015;
        pos *= pulse * uScale;
        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = (12.0 / -mvPosition.z) * (1.0 + sin(uTime + position.x) * 0.2);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform float uOpacity;
      void main() {
        float dist = distance(gl_PointCoord, vec2(0.5));
        if (dist > 0.5) discard;
        float alpha = smoothstep(0.5, 0.2, dist) * uOpacity;
        gl_FragColor = vec4(0.0, 0.95, 1.0, alpha);
      }
    `;

    const particlesMaterial = new THREE.ShaderMaterial({
      uniforms: this.shaderUniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.particleSphere = new THREE.Points(geometry, particlesMaterial);
    this.scene.add(this.particleSphere);

    this.initCelestialBodies();
  }

  private initCelestialBodies(): void {
    this.celestialGroup = new THREE.Group();
    this.scene.add(this.celestialGroup);

    const bodyCount = 80; 
    const colors = [0x00ffff, 0xffffff, 0xffff66, 0x99ffff];
    
    for (let i = 0; i < bodyCount; i++) {
      const baseScale = 0.01 + Math.random() * 0.025;
      const geometry = new THREE.IcosahedronGeometry(baseScale, 0);
      const baseOpacity = 0.15 + Math.random() * 0.35;
      const material = new THREE.MeshBasicMaterial({
        color: colors[Math.floor(Math.random() * colors.length)],
        transparent: true,
        opacity: baseOpacity
      });

      const mesh = new THREE.Mesh(geometry, material);
      const dist = 6.0 + Math.random() * 6.0; 
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      
      mesh.position.set(
        dist * Math.sin(phi) * Math.cos(theta),
        dist * Math.sin(phi) * Math.sin(theta),
        dist * Math.cos(phi)
      );

      this.celestialBodies.push({
        mesh: mesh,
        velocity: new THREE.Vector3((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01),
        rotationSpeed: new THREE.Vector3(Math.random() * 0.04, Math.random() * 0.04, 0),
        baseOpacity,
        noiseOffset: Math.random() * 1000,
        hitHighlight: 0,
        baseScale
      });
      this.celestialGroup.add(mesh);
    }
  }

  private updatePhysics(delta: number): void {
    const time = this.clock.getElapsedTime();
    this.shaderUniforms.uTime.value = time;

    // Reset Scale mượt mà về kích thước BASE của thiết bị
    if (this.isShuttingDown()) {
      this.targetGlobeScale += (this.baseGlobeScale - this.targetGlobeScale) * 0.07;
      this.zoomVelocity *= 0.4;
    }

    if (Math.abs(this.zoomVelocity) > 0.0001) {
      this.targetGlobeScale += this.zoomVelocity;
      this.targetGlobeScale = Math.max(this.minScale, Math.min(this.maxScale, this.targetGlobeScale));
      this.zoomVelocity *= this.zoomDampingFactor;
    }
    this.currentGlobeScale += (this.targetGlobeScale - this.currentGlobeScale) * 0.15;
    this.shaderUniforms.uScale.value = this.currentGlobeScale;
    this.worldMapMesh.scale.setScalar(this.currentGlobeScale);

    // Reset Góc xoay mượt mà (Homing)
    if (this.isShuttingDown()) {
      this.particleSphere.quaternion.slerp(new THREE.Quaternion(0, 0, 0, 1), 0.07);
      this.rotationVelocity.slerp(new THREE.Quaternion(0, 0, 0, 1), 0.2);
    } else {
      const idleRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.0003);
      this.particleSphere.quaternion.premultiply(idleRot);

      if (!this.isDragging) {
        this.particleSphere.quaternion.premultiply(this.rotationVelocity);
        this.rotationVelocity.slerp(new THREE.Quaternion(0, 0, 0, 1), this.rotationDrag); 
      }
    }
    
    this.worldMapMesh.quaternion.copy(this.particleSphere.quaternion);

    const avoidanceThreshold = (4.5 * this.currentGlobeScale) + 0.6;
    const center = new THREE.Vector3(0, 0, 0);
    const rotationAngle = 2 * Math.acos(Math.min(1, Math.max(-1, this.rotationVelocity.w)));
    const rotationAxis = new THREE.Vector3(this.rotationVelocity.x, this.rotationVelocity.y, this.rotationVelocity.z).normalize();

    for (const body of this.celestialBodies) {
      const pos = body.mesh.position;
      const noise = body.noiseOffset;
      body.velocity.x += Math.sin(time * 0.5 + noise) * 0.0004;
      body.velocity.y += Math.cos(time * 0.4 + noise) * 0.0004;
      body.velocity.z += Math.sin(time * 0.6 + noise) * 0.0004;

      if (rotationAngle > 0.001) {
        const distFromCenter = pos.length();
        const stirStrength = (rotationAngle * 0.04) / (distFromCenter * 0.5);
        const tangent = new THREE.Vector3().crossVectors(rotationAxis, pos.clone().normalize()).normalize();
        body.velocity.add(tangent.multiplyScalar(stirStrength));
      }

      pos.add(body.velocity);
      body.mesh.rotation.x += body.rotationSpeed.x;
      body.mesh.rotation.y += body.rotationSpeed.y;

      if (body.hitHighlight > 0) {
        body.hitHighlight -= 0.03;
        if (body.hitHighlight < 0) body.hitHighlight = 0;
      }

      const sparkle = Math.sin(time * 2 + noise) * 0.1;
      const finalOpacity = THREE.MathUtils.lerp(body.baseOpacity + sparkle, 1.0, body.hitHighlight);
      body.mesh.material.opacity = finalOpacity;
      body.mesh.scale.setScalar(1.0 + body.hitHighlight * 1.5);

      const dist = pos.length();
      if (dist < avoidanceThreshold) {
        const normal = pos.clone().normalize();
        pos.setLength(avoidanceThreshold + 0.1);
        body.velocity.reflect(normal).multiplyScalar(0.8);
        body.velocity.add(normal.multiplyScalar(0.05)); 
        body.hitHighlight = 1.0;
      } else if (dist > 13.0) {
        body.velocity.add(center.clone().sub(pos).normalize().multiplyScalar(0.003));
      }
      body.velocity.multiplyScalar(0.985); 
    }
  }

  async toggleHandControl() {
    if (this.isCameraActive()) {
      this.isShuttingDown.set(true);
      this.isHandDetected.set(false);
      
      // Chờ hoàn tất chu kỳ homing mượt mà
      await new Promise(resolve => setTimeout(resolve, 850));
      
      this.isCameraActive.set(false);
      this.isShuttingDown.set(false);
      this.activeFingers.set(0);
      this.smoothedSpread = 0;
      
      if (this.mediaPipeCamera) await this.mediaPipeCamera.stop();
      return;
    }

    this.isLoadingCamera.set(true);
    try {
      if (!this.hands) {
        this.hands = new Hands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });
        this.hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.8,
          minTrackingConfidence: 0.8
        });
        this.hands.onResults((results: any) => this.onHandResults(results));
      }
      if (!this.mediaPipeCamera) {
        this.mediaPipeCamera = new Camera(this.videoRef().nativeElement, {
          onFrame: async () => {
            if (this.isCameraActive() && !this.isShuttingDown()) {
              await this.hands.send({ image: this.videoRef().nativeElement });
            }
          },
          width: 480,
          height: 360
        });
      }
      await this.mediaPipeCamera.start();
      this.isCameraActive.set(true);
    } catch (error) {
      console.error(error);
    } finally {
      this.isLoadingCamera.set(false);
    }
  }

  private onHandResults(results: any): void {
    if (this.isShuttingDown()) return;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      this.isHandDetected.set(true);
      const landmarks = results.multiHandLandmarks[0];
      
      let fingers = 0;
      if (landmarks[8].y < landmarks[6].y) fingers++;
      if (landmarks[12].y < landmarks[10].y) fingers++;
      if (landmarks[16].y < landmarks[14].y) fingers++;
      if (landmarks[20].y < landmarks[18].y) fingers++;
      if (Math.abs(landmarks[4].x - landmarks[5].x) > 0.045) fingers++;
      this.activeFingers.set(fingers);

      if (fingers >= 4) {
        const center = landmarks[9];
        const dx = (center.x - this.smoothedHandPos.x);
        const dy = (center.y - this.smoothedHandPos.y);
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > this.rotationDeadZone) {
          const axis = new THREE.Vector3(dy, -dx, 0).normalize();
          const angle = Math.pow(dist, 1.25) * 25.0; 
          const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);
          this.particleSphere.quaternion.premultiply(dq);
          this.rotationVelocity.copy(dq);
        }
        
        this.smoothedHandPos.x += dx * this.smoothingAlpha;
        this.smoothedHandPos.y += dy * this.smoothingAlpha;

        const wrist = landmarks[0];
        const distToWrist = Math.hypot(wrist.x - center.x, wrist.y - center.y);
        const thumb = landmarks[4];
        const pinky = landmarks[20];
        const spread = Math.hypot(thumb.x - pinky.x, thumb.y - pinky.y) / (distToWrist || 1);
        
        if (this.smoothedSpread !== 0) {
          const deltaSpread = spread - this.smoothedSpread;
          if (Math.abs(deltaSpread) > 0.02) {
            this.zoomVelocity += deltaSpread * 0.45;
          }
        }
        this.smoothedSpread = spread;
      }
    } else {
      this.isHandDetected.set(false);
      this.activeFingers.set(0);
      this.smoothedSpread = 0;
    }
  }

  private animate(): void {
    this.animationFrameId = requestAnimationFrame(() => this.animate());
    this.updatePhysics(this.clock.getDelta());
    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    
    // Cập nhật lại kích thước cơ sở khi xoay màn hình
    this.updateBaseScale();
  }

  onPointerDown(event: PointerEvent): void {
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.isDragging = true;
      this.rotationVelocity.set(0, 0, 0, 1);
      this.previousPointerPosition = { x: event.clientX, y: event.clientY };
    } else if (this.pointers.size === 2) {
      this.lastPinchDistance = this.getPinchDistance();
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (this.pointers.size === 1 && this.isDragging) {
      const dx = event.clientX - this.previousPointerPosition.x;
      const dy = event.clientY - this.previousPointerPosition.y;
      const axis = new THREE.Vector3(dy, dx, 0).normalize();
      
      const angle = Math.sqrt(dx * dx + dy * dy) * 0.012; 
      if (angle > 0) {
        const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        this.particleSphere.quaternion.premultiply(dq);
        this.rotationVelocity.copy(dq);
      }
      this.previousPointerPosition = { x: event.clientX, y: event.clientY };
    } else if (this.pointers.size === 2) {
      const currentDist = this.getPinchDistance();
      this.zoomVelocity += (currentDist - this.lastPinchDistance) * 0.008;
      this.lastPinchDistance = currentDist;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.isDragging = false;
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  onWheel(event: WheelEvent): void { 
    this.zoomVelocity -= event.deltaY * 0.001; 
  }
}
