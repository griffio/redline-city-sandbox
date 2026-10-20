// WebGPU renderer.
//  pass 1 (persistent): skid-mark segments accumulate into a world-sized r8 texture
//  pass 2: procedural ground (asphalt, paint, grass) sampling the skid texture, and in course mode
//          the baked course texture (distance to the track, kerb stripes; see courses/groundmap.js)
//  pass 3: one instanced draw for every sprite, all from the software-rendered atlas
import { ATLAS_W, ATLAS_H, REGIONS } from '../sprites.js';
import { WORLD } from '../physics/world.js';

const SKID_RES = 4096;
const SKID_EXTENT = WORLD.half + 20; // metres from origin covered by the skid texture
const SPRITE_FLOATS = 16;
const SKID_FLOATS = 8;
const MAX_SKIDS = 8192;
export const COURSE_RES = 1024; // course texture covers the same square as the skid texture
export const COURSE_EXTENT = SKID_EXTENT;
export const GROUND_MODE = { sandbox: 0, track: 1, guide: 2 };

const COMMON = /* wgsl */ `
struct Cam {
  center: vec2f,
  rotCS: vec2f,     // cos/sin of the world→screen rotation
  viewport: vec2f,  // pixels
  scale: f32,       // pixels per metre
  time: f32,
  skidRect: vec4f,  // minX, minY, sizeX, sizeY
};
@group(0) @binding(0) var<uniform> cam: Cam;

fn worldToNdc(w: vec2f) -> vec4f {
  let d = w - cam.center;
  let c = cam.rotCS.x; let s = cam.rotCS.y;
  let r = vec2f(d.x * c - d.y * s, d.x * s + d.y * c);
  return vec4f(r * 2.0 * cam.scale / cam.viewport, 0.0, 1.0);
}
`;

const GROUND_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var skidTex: texture_2d<f32>;
@group(0) @binding(2) var skidSamp: sampler;
// tileable mipmapped noise: R = fbm (big), G = fbm (mid/wear/grass), B = white grain, A = fbm (patches)
@group(0) @binding(3) var noiseTex: texture_2d<f32>;
@group(0) @binding(4) var noiseSamp: sampler;
// course: R = distance to the centreline (m), G/B = cos/sin of the kerb stripe phase, A = kerb
@group(0) @binding(5) var courseTex: texture_2d<f32>;
struct Course {
  mode: f32,      // 0 sandbox, 1 track with walls and grass, 2 open arena with a route guide
  halfW: f32,     // half the track width
  wall: f32,      // walls stand this far outside the painted edge
  closed: f32,    // 1 = loop (one timing line), 0 = start and finish lines
  start: vec4f,   // timing line: position xy, direction of travel zw
  finish: vec4f,
};
@group(0) @binding(6) var<uniform> course: Course;

const HALF: f32 = ${WORLD.half.toFixed(1)};
const SKIDPAD = vec3f(${WORLD.skidpad.x.toFixed(1)}, ${WORLD.skidpad.y.toFixed(1)}, ${WORLD.skidpad.r.toFixed(1)});
const FIG8 = vec3f(${WORLD.figure8.x.toFixed(1)}, ${WORLD.figure8.y.toFixed(1)}, ${WORLD.figure8.r.toFixed(1)});
const DRAG = vec3f(${WORLD.dragStrip.y.toFixed(1)}, ${WORLD.dragStrip.x0.toFixed(1)}, ${WORLD.dragStrip.x1.toFixed(1)});

struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.ndc = p[i];
  return o;
}

// anti-aliased line mask: distance d (m), half width w (m), pixel size px (m)
fn line(d: f32, w: f32, px: f32) -> f32 { return 1.0 - smoothstep(w - px, w + px, abs(d)); }
fn dashed(t: f32, period: f32, duty: f32) -> f32 { return step(fract(t / period), duty); }
// 1 m chequers across a timing line: 0 or 1 inside it, -1 outside
fn chequer(w: vec2f, l: vec4f, halfW: f32) -> f32 {
  let p = w - l.xy;
  let along = dot(p, l.zw);
  let across = dot(p, vec2f(-l.w, l.z));
  if (abs(along) > 1.0 || abs(across) > halfW) { return -1.0; }
  return f32((i32(floor(along + 1.0)) + i32(floor(across + 64.0))) & 1);
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  // reconstruct world position
  let r = in.ndc * cam.viewport / (2.0 * cam.scale);
  let c = cam.rotCS.x; let s = cam.rotCS.y;
  let w = cam.center + vec2f(r.x * c + r.y * s, -r.x * s + r.y * c);
  let px = 1.0 / cam.scale;

  let suv = vec2f((w.x - cam.skidRect.x) / cam.skidRect.z, 1.0 - (w.y - cam.skidRect.y) / cam.skidRect.w);
  let skid = textureSampleLevel(skidTex, skidSamp, suv, 0.0).r;

  // noise lookups up front (implicit-derivative samples must be in uniform control flow)
  let big = textureSample(noiseTex, noiseSamp, w / 400.0).r;    // ~50m blotches
  let midN = textureSample(noiseTex, noiseSamp, w / 37.0).g;    // ~4.6m
  let grain = textureSample(noiseTex, noiseSamp, w / 10.667).b; // 24 texels per metre
  let patchN = textureSample(noiseTex, noiseSamp, w / 800.0 + vec2f(0.37, 0.11)).a;
  let wearN = textureSample(noiseTex, noiseSamp, w / 5.0).g;
  let grassN = textureSample(noiseTex, noiseSamp, w / 23.0).g;
  let dirtN = textureSample(noiseTex, noiseSamp, w / 133.0 + vec2f(0.5, 0.25)).r;

  // asphalt
  var col = vec3f(0.2, 0.205, 0.212) * (0.82 + 0.3 * big) + (midN - 0.5) * 0.035 + (grain - 0.5) * 0.045;
  // repaired patches
  let patches = smoothstep(0.6, 0.62, patchN);
  col = mix(col, col * 0.78, patches * 0.8);
  // stones / aggregate sparkle
  col += vec3f(smoothstep(0.93, 0.98, grain) * 0.05);

  // paint
  var paint = 0.0;
  var yellow = 0.0;
  var kerb = 0.0;
  var kerbCol = vec3f(0.0);
  var offTrack = 0.0; // 1 = grass beyond a course's walls
  let cm = textureSampleLevel(courseTex, skidSamp, suv, 0.0);
  if (course.mode < 0.5 || course.mode > 1.5) {
    // grid every 10m, stronger every 50m
    let g10 = min(line(fract(w.x / 10.0 + 0.5) * 10.0 - 5.0, 0.05, px), 1.0);
    let g10y = line(fract(w.y / 10.0 + 0.5) * 10.0 - 5.0, 0.05, px);
    paint = max(paint, max(g10, g10y) * 0.07);
    let g50 = max(line(fract(w.x / 50.0 + 0.5) * 50.0 - 25.0, 0.09, px), line(fract(w.y / 50.0 + 0.5) * 50.0 - 25.0, 0.09, px));
    paint = max(paint, g50 * 0.16);
  }
  if (course.mode < 0.5) {
    // feature paint, each gated by a cheap bounds test so most pixels skip the atan2/ring maths
    let dsp = length(w - SKIDPAD.xy);
    if (abs(dsp - SKIDPAD.z - 4.0) < 5.0) {
      // skidpad: two yellow rings + dashed centre line
      yellow = max(yellow, line(dsp - SKIDPAD.z, 0.12, px));
      yellow = max(yellow, line(dsp - SKIDPAD.z - 8.0, 0.12, px));
      let ang = atan2(w.y - SKIDPAD.y, w.x - SKIDPAD.x);
      paint = max(paint, line(dsp - SKIDPAD.z - 4.0, 0.08, px) * dashed(ang * (SKIDPAD.z + 4.0), 3.0, 0.5));
    }
    if (abs(w.y - FIG8.y) < 11.0 && abs(w.x - FIG8.x) < FIG8.z + 11.0) {
      // figure-8 rings around the two pylons
      let d8a = length(w - FIG8.xy + vec2f(FIG8.z, 0.0));
      let d8b = length(w - FIG8.xy - vec2f(FIG8.z, 0.0));
      paint = max(paint, line(d8a - 10.0, 0.1, px) * dashed(atan2(w.y - FIG8.y, w.x - FIG8.x + FIG8.z) * 10.0, 2.0, 0.6));
      paint = max(paint, line(d8b - 10.0, 0.1, px) * dashed(atan2(w.y - FIG8.y, w.x - FIG8.x - FIG8.z) * 10.0, 2.0, 0.6));
    }
    if (abs(w.y - DRAG.x) < 6.5 && w.x > DRAG.y && w.x < DRAG.z) {
      // drag strip lanes + checkered start line
      paint = max(paint, line(w.y - DRAG.x - 6.0, 0.12, px));
      paint = max(paint, line(w.y - DRAG.x + 6.0, 0.12, px));
      paint = max(paint, line(w.y - DRAG.x, 0.08, px) * dashed(w.x, 6.0, 0.5));
      let sx = w.x - (DRAG.y + 6.0);
      if (abs(sx) < 1.0 && abs(w.y - DRAG.x) < 6.0) {
        let ch = (i32(floor(sx + 1.0)) + i32(floor(w.y))) & 1;
        col = mix(col, select(vec3f(0.05), vec3f(0.85), ch == 0), 0.85);
      }
    }
    if (abs(w.x) < 2.0 && abs(w.y) < 3.4) {
      // start box at origin
      let b = abs(w) - vec2f(1.6, 3.0);
      paint = max(paint, line(max(b.x, b.y), 0.08, px));
    }
  } else if (course.mode < 1.5) {
    // track: white edge lines, red/white kerbs on the corners, a darker run-off strip up to the
    // walls, grass beyond them
    let d = abs(cm.r);
    let hw = course.halfW;
    paint = max(paint, line(d - (hw - 0.3), 0.08, px));
    kerb = (1.0 - smoothstep(hw + 0.15 - px, hw + 0.15 + px, d)) * smoothstep(hw - 1.05 - px, hw - 1.05 + px, d) * step(0.5, cm.a);
    kerbCol = mix(vec3f(0.9, 0.9, 0.88), vec3f(0.76, 0.07, 0.08), step(0.0, cm.b));
    col = mix(col, col * 0.8, smoothstep(hw - px, hw + px, d));
    offTrack = smoothstep(hw + course.wall + 0.35, hw + course.wall + 0.6, d);
    for (var k = 0; k < 2; k++) {
      if (k == 1 && course.closed > 0.5) { break; }
      let ch = chequer(w, select(course.start, course.finish, k == 1), hw);
      if (ch >= 0.0) { col = mix(col, select(vec3f(0.05), vec3f(0.85), ch < 0.5), 0.85); }
    }
  } else {
    // open arena: a faint dashed guide along the route and a start box
    paint = max(paint, (1.0 - smoothstep(0.12 - px, 0.12 + px, abs(cm.r))) * step(0.0, cm.b) * 0.35);
    let p = w - course.start.xy;
    let b = abs(vec2f(dot(p, course.start.zw), dot(p, vec2f(-course.start.w, course.start.z)))) - vec2f(3.0, 1.6);
    paint = max(paint, line(max(b.x, b.y), 0.08, px));
  }

  let wear = 0.7 + 0.3 * wearN;
  col = mix(col, vec3f(0.82, 0.82, 0.8), paint * wear);
  col = mix(col, vec3f(0.86, 0.68, 0.12), yellow * wear * 0.9);
  col = mix(col, kerbCol, kerb * (0.85 + 0.15 * wearN));

  // rubber
  col = mix(col, vec3f(0.025, 0.025, 0.028), clamp(skid, 0.0, 1.0) * 0.88);

  var grass = vec3f(0.16, 0.24, 0.1) * (0.75 + 0.5 * grassN) + (grain - 0.5) * 0.04;
  grass = mix(grass, vec3f(0.3, 0.26, 0.18), smoothstep(0.55, 0.7, dirtN) * 0.6);
  col = mix(col, grass, offTrack);

  // outside the arena: kerb strip then scrubby grass
  let edge = max(abs(w.x), abs(w.y)) - HALF;
  if (edge > 0.45) {
    let strip = 1.0 - smoothstep(2.5, 2.6, edge);
    let stripe = step(0.5, fract((w.x + w.y) / 3.0));
    col = mix(grass, mix(vec3f(0.85), vec3f(0.75, 0.08, 0.08), stripe), strip);
  }
  return vec4f(col, 1.0);
}
`;

const SPRITE_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct Inst {
  @location(0) posSize: vec4f,
  @location(1) rotAdd: vec4f,
  @location(2) uv: vec4f,
  @location(3) color: vec4f,
};
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) add: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                                vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let k = corners[vi];
  let local = k * inst.posSize.zw * 0.5;
  let c = cos(inst.rotAdd.x); let s = sin(inst.rotAdd.x);
  let w = inst.posSize.xy + vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  var o: VOut;
  o.pos = worldToNdc(w);
  o.uv = mix(inst.uv.xy, inst.uv.zw, vec2f((k.x + 1.0) * 0.5, (1.0 - k.y) * 0.5));
  o.color = inst.color;
  o.add = inst.rotAdd.y;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let t = textureSample(atlas, samp, in.uv); // premultiplied
  var o = t * vec4f(in.color.rgb * in.color.a, in.color.a);
  o.a = o.a * (1.0 - in.add); // additive when add = 1
  return o;
}
`;

const SKID_WGSL = /* wgsl */ `
${COMMON}
struct VOut { @builtin(position) pos: vec4f, @location(0) across: f32, @location(1) k: f32 };

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) seg: vec4f, @location(1) wi: vec4f) -> VOut {
  var corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                                vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let k = corners[vi];
  let a = seg.xy; let b = seg.zw;
  let dir = normalize(b - a + vec2f(1e-5, 0.0));
  let n = vec2f(-dir.y, dir.x);
  // extend slightly past each end so consecutive segments join without gaps
  let p = mix(a - dir * wi.x * 0.4, b + dir * wi.x * 0.4, k.x) + n * k.y * wi.x * 0.5;
  let uv = (p - cam.skidRect.xy) / cam.skidRect.zw;
  var o: VOut;
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  o.across = k.y;
  o.k = wi.y;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let edge = 1.0 - smoothstep(0.45, 1.0, abs(in.across));
  // tread grooves
  let tread = 0.8 + 0.2 * step(0.5, fract(in.across * 2.5 + 0.5));
  let a = clamp(in.k * edge * tread, 0.0, 1.0);
  return vec4f(a, a, a, a);
}
`;

export class Renderer {
  async init(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    // GPU timing (timestamp queries) drives the perf overlay and dynamic resolution
    this.canTime = adapter.features.has('timestamp-query');
    this.device = await adapter.requestDevice({ requiredFeatures: this.canTime ? ['timestamp-query'] : [] });
    this.device.lost.then((info) => console.error('WebGPU device lost:', info.message));
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const d = this.device;
    this.gpuMs = null; // last measured GPU frame time (ms), null when unsupported
    this.gpuPasses = {}; // per-pass ms when detailTiming is on
    this.detailTiming = false; // split ground/sprite passes for attribution (costs an extra load/store)
    if (this.canTime) {
      this.querySet = d.createQuerySet({ type: 'timestamp', count: 8 });
      this.queryResolve = d.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.queryReads = Array.from({ length: 3 }, () => ({
        buf: d.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        busy: false,
      }));
    }
    this.camBuf = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.camData = new Float32Array(12);

    // skid texture
    this.skidTex = d.createTexture({
      size: [SKID_RES, SKID_RES],
      format: 'r8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.skidView = this.skidTex.createView();
    this.skidCleared = false;
    this.inFlight = 0;
    this.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 1 });

    // atlas with mips
    this.atlasMips = 6;
    this.atlasTex = d.createTexture({
      size: [ATLAS_W, ATLAS_H],
      format: 'rgba8unorm',
      mipLevelCount: this.atlasMips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const blendPremul = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    // course texture + params (mode 0 = sandbox, so neither is read until a course loads)
    this.courseTex = d.createTexture({
      size: [COURSE_RES, COURSE_RES], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.courseBuf = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.courseData = new Float32Array(12);
    d.queue.writeBuffer(this.courseBuf, 0, this.courseData);

    // ground
    this.noiseTex = createNoiseTexture(d);
    this.repeat = d.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
    });
    const gm = d.createShaderModule({ code: GROUND_WGSL });
    this.groundPipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: gm, entryPoint: 'vs' },
      fragment: { module: gm, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.groundBind = d.createBindGroup({
      layout: this.groundPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: this.skidView },
        { binding: 2, resource: this.linear },
        { binding: 3, resource: this.noiseTex.createView() },
        { binding: 4, resource: this.repeat },
        { binding: 5, resource: this.courseTex.createView() },
        { binding: 6, resource: { buffer: this.courseBuf } },
      ],
    });

    // sprites
    const sm = d.createShaderModule({ code: SPRITE_WGSL });
    this.spritePipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: sm,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: SPRITE_FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'float32x4' },
            { shaderLocation: 3, offset: 48, format: 'float32x4' },
          ],
        }],
      },
      fragment: { module: sm, entryPoint: 'fs', targets: [{ format: this.format, blend: blendPremul }] },
      primitive: { topology: 'triangle-list' },
    });
    this.spriteBind = d.createBindGroup({
      layout: this.spritePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: this.atlasTex.createView() },
        { binding: 2, resource: this.linear },
      ],
    });
    this.spriteCap = 4096;
    this.spriteData = new Float32Array(this.spriteCap * SPRITE_FLOATS);
    this.spriteBuf = d.createBuffer({ size: this.spriteData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.spriteCount = 0;

    // skids
    const km = d.createShaderModule({ code: SKID_WGSL });
    this.skidPipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: km,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: SKID_FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
        }],
      },
      fragment: { module: km, entryPoint: 'fs', targets: [{ format: 'r8unorm', blend: blendPremul }] },
      primitive: { topology: 'triangle-list' },
    });
    this.skidBind = d.createBindGroup({
      layout: this.skidPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.camBuf } }],
    });
    this.skidData = new Float32Array(MAX_SKIDS * SKID_FLOATS);
    this.skidBuf = d.createBuffer({ size: this.skidData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.skidCount = 0;

    // pre-computed UVs per region
    this.uv = {};
    for (const [name, r] of Object.entries(REGIONS)) {
      const [x, y, w, h] = r.px;
      this.uv[name] = [x / ATLAS_W, y / ATLAS_H, (x + w) / ATLAS_W, (y + h) / ATLAS_H];
    }
  }

  /** Upload the software-rendered atlas, generating mips on the CPU with canvas downscaling. */
  uploadAtlas(canvas) {
    let src = canvas;
    for (let level = 0; level < this.atlasMips; level++) {
      const w = Math.max(1, ATLAS_W >> level), h = Math.max(1, ATLAS_H >> level);
      if (level > 0) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, w, h);
        src = c;
      }
      this.device.queue.copyExternalImageToTexture(
        { source: src },
        { texture: this.atlasTex, mipLevel: level, premultipliedAlpha: true },
        [w, h],
      );
    }
  }

  clearSkids() {
    this.skidCleared = false;
  }

  /**
   * Paint a course: `map` from bakeCourseMap(), plus how to draw it.
   * @param p {mode, halfW, wall, closed, start: [x, y, dx, dy], finish: [x, y, dx, dy]}
   */
  setCourse(map, p) {
    if (map) {
      this.device.queue.writeTexture({ texture: this.courseTex }, map, { bytesPerRow: COURSE_RES * 8 }, [COURSE_RES, COURSE_RES]);
    }
    const D = this.courseData;
    D.set([p.mode, p.halfW ?? 0, p.wall ?? 0, p.closed ? 1 : 0, ...(p.start ?? [0, 0, 1, 0]), ...(p.finish ?? [0, 0, 1, 0])]);
    this.device.queue.writeBuffer(this.courseBuf, 0, D);
  }

  clearCourse() {
    this.setCourse(null, { mode: GROUND_MODE.sandbox });
  }

  /** @param scale fraction of native (devicePixelRatio, capped at 2) resolution to render at */
  resize(scale = 1) {
    const dpr = Math.min(devicePixelRatio || 1, 2) * scale;
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  begin() {
    this.spriteCount = 0;
  }

  /** Queue a sprite. rot in radians, color [r,g,b,a] straight alpha, add=1 for additive. */
  sprite(region, x, y, w, h, rot = 0, color = WHITE, add = 0) {
    if (this.spriteCount >= this.spriteCap) this.growSprites();
    const uv = this.uv[region];
    const o = this.spriteCount++ * SPRITE_FLOATS;
    const D = this.spriteData;
    D[o] = x; D[o + 1] = y; D[o + 2] = w; D[o + 3] = h;
    D[o + 4] = rot; D[o + 5] = add;
    D[o + 8] = uv[0]; D[o + 9] = uv[1]; D[o + 10] = uv[2]; D[o + 11] = uv[3];
    D[o + 12] = color[0]; D[o + 13] = color[1]; D[o + 14] = color[2]; D[o + 15] = color[3];
  }

  growSprites() {
    this.spriteCap *= 2;
    const n = new Float32Array(this.spriteCap * SPRITE_FLOATS);
    n.set(this.spriteData);
    this.spriteData = n;
    this.spriteBuf.destroy();
    this.spriteBuf = this.device.createBuffer({ size: n.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  skid(x0, y0, x1, y1, width, intensity) {
    if (this.skidCount >= MAX_SKIDS) return;
    const o = this.skidCount++ * SKID_FLOATS;
    const D = this.skidData;
    D[o] = x0; D[o + 1] = y0; D[o + 2] = x1; D[o + 3] = y1;
    D[o + 4] = width; D[o + 5] = intensity;
  }

  render(cam) {
    const d = this.device;
    const W = this.canvas.width, H = this.canvas.height;
    const theta = Math.PI / 2 - cam.rot;
    const C = this.camData;
    C[0] = cam.x + cam.shakeX; C[1] = cam.y + cam.shakeY;
    C[2] = Math.cos(theta); C[3] = Math.sin(theta);
    C[4] = W; C[5] = H;
    C[6] = cam.scale(H);
    C[7] = performance.now() / 1000;
    C[8] = -SKID_EXTENT; C[9] = -SKID_EXTENT; C[10] = SKID_EXTENT * 2; C[11] = SKID_EXTENT * 2;
    d.queue.writeBuffer(this.camBuf, 0, C);

    const enc = d.createCommandEncoder();
    // timestamp pairs: 0-1 skids, 2-3 main (or ground), 4-5 sprites (detail mode only)
    const ts = (i) => (this.canTime ? { querySet: this.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } : undefined);
    const timed = [];
    if (this.skidCount > 0 || !this.skidCleared) {
      d.queue.writeBuffer(this.skidBuf, 0, this.skidData, 0, this.skidCount * SKID_FLOATS);
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.skidView,
          loadOp: this.skidCleared ? 'load' : 'clear',
          clearValue: [0, 0, 0, 0],
          storeOp: 'store',
        }],
        timestampWrites: ts(0),
      });
      timed.push(['skids', 0]);
      if (this.skidCount) {
        pass.setPipeline(this.skidPipe);
        pass.setBindGroup(0, this.skidBind);
        pass.setVertexBuffer(0, this.skidBuf);
        pass.draw(6, this.skidCount);
      }
      pass.end();
      this.skidCleared = true;
      this.skidCount = 0;
    }

    d.queue.writeBuffer(this.spriteBuf, 0, this.spriteData, 0, this.spriteCount * SPRITE_FLOATS);
    const target = this.ctx.getCurrentTexture().createView();
    const split = this.detailTiming && this.canTime;
    let pass = enc.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', clearValue: [0.1, 0.1, 0.1, 1], storeOp: 'store' }],
      timestampWrites: ts(2),
    });
    timed.push([split ? 'ground' : 'main', 2]);
    pass.setPipeline(this.groundPipe);
    pass.setBindGroup(0, this.groundBind);
    pass.draw(3);
    if (split) {
      pass.end();
      pass = enc.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: ts(4),
      });
      timed.push(['sprites', 4]);
    }
    if (this.spriteCount) {
      pass.setPipeline(this.spritePipe);
      pass.setBindGroup(0, this.spriteBind);
      pass.setVertexBuffer(0, this.spriteBuf);
      pass.draw(6, this.spriteCount);
    }
    pass.end();

    const read = this.canTime && this.queryReads.find((r) => !r.busy);
    if (read) {
      enc.resolveQuerySet(this.querySet, 0, 6, this.queryResolve, 0);
      enc.copyBufferToBuffer(this.queryResolve, 0, read.buf, 0, 48);
    }
    d.queue.submit([enc.finish()]);
    this.inFlight++;
    d.queue.onSubmittedWorkDone().then(() => this.inFlight--);
    if (read) {
      read.busy = true;
      read.buf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(read.buf.getMappedRange());
        let total = 0;
        const passes = {};
        for (const [name, i] of timed) {
          const ms = Number(t[i + 1] - t[i]) / 1e6;
          if (ms >= 0 && ms < 1000) { passes[name] = ms; total += ms; }
        }
        read.buf.unmap();
        read.busy = false;
        this.gpuPasses = passes;
        this.gpuMs = total;
      }).catch(() => { read.busy = false; });
    }
  }

  /** True when the GPU is far enough behind that queuing another frame would only add input lag. */
  get backlogged() {
    return this.inFlight >= 2;
  }
}

const WHITE = [1, 1, 1, 1];

/**
 * Bake the ground's noise once on the CPU: a 256² tileable RGBA texture with a full mip chain.
 * Replaces ~13 per-pixel value-noise evaluations with a handful of filtered fetches (and the
 * mips stop the grain shimmering when the camera zooms out).
 */
function createNoiseTexture(device, N = 256) {
  let seed = 1337;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // periodic value-noise fbm, same shape as the old shader fbm: 4 octaves, amplitude halving
  const fbm = (period) => {
    const out = new Float32Array(N * N);
    let amp = 0.5;
    for (let o = 0; o < 4; o++, period *= 2, amp *= 0.5) {
      const lat = Float32Array.from({ length: period * period }, rand);
      const cell = N / period;
      for (let y = 0; y < N; y++) {
        const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        const y0 = (iy % period) * period, y1 = ((iy + 1) % period) * period;
        for (let x = 0; x < N; x++) {
          const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % period, x1 = (ix + 1) % period;
          const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * sx;
          const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * sx;
          out[y * N + x] += amp * (a + (b - a) * sy);
        }
      }
    }
    return out;
  };
  const r = fbm(8), g = fbm(8), a = fbm(8);
  let level = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    level[i * 4] = r[i] * 255;
    level[i * 4 + 1] = g[i] * 255;
    level[i * 4 + 2] = rand() * 255;
    level[i * 4 + 3] = a[i] * 255;
  }
  const mips = Math.log2(N) + 1;
  const tex = device.createTexture({
    size: [N, N], format: 'rgba8unorm', mipLevelCount: mips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  for (let m = 0, size = N; m < mips; m++, size >>= 1) {
    device.queue.writeTexture({ texture: tex, mipLevel: m }, level, { bytesPerRow: size * 4 }, [size, size]);
    if (size === 1) break;
    // 2x2 box filter for the next level
    const half = size >> 1, next = new Uint8Array(half * half * 4);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        for (let c = 0; c < 4; c++) {
          const i = ((y * 2) * size + x * 2) * 4 + c;
          next[(y * half + x) * 4 + c] = (level[i] + level[i + 4] + level[i + size * 4] + level[i + size * 4 + 4]) >> 2;
        }
      }
    }
    level = next;
  }
  return tex;
}
