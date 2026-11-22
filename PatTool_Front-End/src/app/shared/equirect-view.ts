/**
 * Perspective view of an equirectangular 360° photo.
 * Drag to look around. The image must already be same-origin (decoded HTMLImageElement).
 */
export class EquirectView {
	readonly canvas: HTMLCanvasElement;
	onLook?: (yaw: number, pitch: number) => void;
	onTap?: () => void;
	onError?: () => void;

	private gl: WebGLRenderingContext | null;
	private program: WebGLProgram | null = null;
	private texture: WebGLTexture | null = null;
	private position = -1;
	private yaw = 0;
	private pitch = 0;
	private imageUrl = '';
	private loadToken = 0;
	private destroyed = false;
	private dragging = false;
	private lastX = 0;
	private lastY = 0;
	private moved = 0;
	private resizeObserver: ResizeObserver | null = null;
	private readonly onDown = (event: PointerEvent) => this.pointerDown(event);
	private readonly onMove = (event: PointerEvent) => this.pointerMove(event);
	private readonly onUp = (event: PointerEvent) => this.pointerUp(event);

	constructor(
		canvas: HTMLCanvasElement,
		private readonly fetchImage: (url: string) => Promise<HTMLImageElement>
	) {
		this.canvas = canvas;
		this.gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false, alpha: false });
		if (!this.gl) {
			return;
		}
		this.program = this.createProgram(this.gl);
		if (!this.program) {
			this.gl = null;
			return;
		}
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(canvas);
		canvas.addEventListener('pointerdown', this.onDown);
		canvas.addEventListener('pointermove', this.onMove);
		canvas.addEventListener('pointerup', this.onUp);
		canvas.addEventListener('pointercancel', this.onUp);
		this.resize();
	}

	get supported(): boolean {
		return !!this.gl && !!this.program;
	}

	setAngles(yaw: number, pitch: number): void {
		this.yaw = yaw;
		this.pitch = pitch;
		this.draw();
	}

	setImage(url: string): void {
		if (!this.gl || !url) {
			return;
		}
		if (url === this.imageUrl) {
			return;
		}
		this.imageUrl = url;
		const token = ++this.loadToken;
		this.fetchImage(url).then((image) => {
			if (this.destroyed || token !== this.loadToken || !this.gl) {
				this.releaseObjectUrl(image);
				return;
			}
			this.upload(image);
			this.releaseObjectUrl(image);
			this.draw();
		}).catch(() => {
			if (!this.destroyed && token === this.loadToken) {
				this.onError?.();
			}
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.loadToken++;
		this.resizeObserver?.disconnect();
		this.canvas.removeEventListener('pointerdown', this.onDown);
		this.canvas.removeEventListener('pointermove', this.onMove);
		this.canvas.removeEventListener('pointerup', this.onUp);
		this.canvas.removeEventListener('pointercancel', this.onUp);
		const gl = this.gl;
		if (gl) {
			if (this.texture) {
				gl.deleteTexture(this.texture);
			}
			if (this.program) {
				gl.deleteProgram(this.program);
			}
		}
		this.texture = null;
		this.program = null;
		this.gl = null;
	}

	private pointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		this.dragging = true;
		this.moved = 0;
		this.lastX = event.clientX;
		this.lastY = event.clientY;
		this.canvas.setPointerCapture?.(event.pointerId);
		event.preventDefault();
		event.stopPropagation();
	}

	private pointerMove(event: PointerEvent): void {
		if (!this.dragging) {
			return;
		}
		const dx = event.clientX - this.lastX;
		const dy = event.clientY - this.lastY;
		this.lastX = event.clientX;
		this.lastY = event.clientY;
		this.moved += Math.abs(dx) + Math.abs(dy);
		this.yaw += dx * 0.005;
		this.pitch = Math.max(-1.15, Math.min(1.15, this.pitch - dy * 0.005));
		this.draw();
		this.onLook?.(this.yaw, this.pitch);
		event.preventDefault();
		event.stopPropagation();
	}

	private pointerUp(event: PointerEvent): void {
		if (!this.dragging) {
			return;
		}
		this.dragging = false;
		event.preventDefault();
		event.stopPropagation();
		if (this.moved < 6) {
			this.onTap?.();
		}
	}

	private resize(): void {
		const gl = this.gl;
		if (!gl) {
			return;
		}
		const width = Math.max(1, this.canvas.clientWidth || 1);
		const height = Math.max(1, this.canvas.clientHeight || 1);
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		const pixelsW = Math.max(1, Math.round(width * ratio));
		const pixelsH = Math.max(1, Math.round(height * ratio));
		if (this.canvas.width !== pixelsW || this.canvas.height !== pixelsH) {
			this.canvas.width = pixelsW;
			this.canvas.height = pixelsH;
		}
		gl.viewport(0, 0, pixelsW, pixelsH);
		this.draw();
	}

	private upload(image: HTMLImageElement): void {
		const gl = this.gl;
		if (!gl) {
			return;
		}
		if (!this.texture) {
			this.texture = gl.createTexture();
		}
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	}

	private draw(): void {
		const gl = this.gl;
		const program = this.program;
		if (!gl || !program) {
			return;
		}
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad(gl));
		gl.enableVertexAttribArray(this.position);
		gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
		gl.uniform1f(gl.getUniformLocation(program, 'uYaw'), this.yaw);
		gl.uniform1f(gl.getUniformLocation(program, 'uPitch'), this.pitch);
		gl.uniform2f(gl.getUniformLocation(program, 'uRes'), this.canvas.width, this.canvas.height);
		gl.uniform1i(gl.getUniformLocation(program, 'uReady'), this.texture ? 1 : 0);
		if (this.texture) {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.texture);
			gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
		}
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}

	private quad(gl: WebGLRenderingContext): WebGLBuffer {
		const existing = (this.canvas as HTMLCanvasElement & { __equirectQuad?: WebGLBuffer }).__equirectQuad;
		if (existing) {
			return existing;
		}
		const buffer = gl.createBuffer();
		if (!buffer) {
			throw new Error('equirect buffer');
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
			-1, -1, 1, -1, -1, 1,
			-1, 1, 1, -1, 1, 1
		]), gl.STATIC_DRAW);
		(this.canvas as HTMLCanvasElement & { __equirectQuad?: WebGLBuffer }).__equirectQuad = buffer;
		return buffer;
	}

	private releaseObjectUrl(image: HTMLImageElement): void {
		const objectUrl = (image as HTMLImageElement & { objectUrl?: string }).objectUrl;
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
		}
	}

	private createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
		const vertex = this.shader(gl, gl.VERTEX_SHADER, `
			attribute vec2 aPos;
			void main() {
				gl_Position = vec4(aPos, 0.0, 1.0);
			}
		`);
		const fragment = this.shader(gl, gl.FRAGMENT_SHADER, `
			precision mediump float;
			uniform sampler2D uTex;
			uniform float uYaw;
			uniform float uPitch;
			uniform vec2 uRes;
			uniform int uReady;
			const float PI = 3.14159265;
			void main() {
				if (uReady == 0) {
					gl_FragColor = vec4(0.059, 0.090, 0.165, 1.0);
					return;
				}
				vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
				float aspect = uRes.x / max(uRes.y, 1.0);
				float tanHalf = tan(radians(40.0));
				vec3 ray = normalize(vec3(ndc.x * aspect * tanHalf, ndc.y * tanHalf, 1.0));
				float cp = cos(uPitch);
				float sp = sin(uPitch);
				vec3 pitched = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
				float cy = cos(uYaw);
				float sy = sin(uYaw);
				vec3 dir = vec3(cy * pitched.x + sy * pitched.z, pitched.y, -sy * pitched.x + cy * pitched.z);
				float lon = atan(dir.x, dir.z);
				float lat = asin(clamp(dir.y, -1.0, 1.0));
				vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
				gl_FragColor = texture2D(uTex, uv);
			}
		`);
		if (!vertex || !fragment) {
			return null;
		}
		const program = gl.createProgram();
		if (!program) {
			return null;
		}
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.bindAttribLocation(program, 0, 'aPos');
		gl.linkProgram(program);
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			gl.deleteProgram(program);
			return null;
		}
		this.position = 0;
		return program;
	}

	private shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
		const shader = gl.createShader(type);
		if (!shader) {
			return null;
		}
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}
}
