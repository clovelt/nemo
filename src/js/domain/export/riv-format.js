// @ts-check
// Rive binary (.riv) writer: pure, no DOM, no Paper, no network. It turns a
// list of Rive core objects into the bytes Rive's runtimes read, so Nemo can
// write a .riv itself instead of driving a running Rive Editor over MCP
// (rive-export.js). This module is only the file format; deciding which Nemo
// strokes become which Rive objects stays with the exporter that calls it.
//
// Format (rive-app/rive-runtime, MIT):
//   - include/rive/runtime_header.hpp: "RIVE", major version (varuint, the
//     runtime expects 7), minor (varuint), file id (varuint64), then a
//     property table of contents: 0-terminated property keys followed by
//     their 2-bit field types packed in uint32s. The ToC is only consulted
//     for keys the reading runtime does not know, so a writer that only uses
//     known keys may leave it empty.
//   - src/file.cpp readRuntimeObject: each object is its type key (varuint),
//     then (property key varuint, value) pairs, terminated by key 0.
//   - core field types: uint/id = varuint, double = float32 LE,
//     color = uint32 LE (ARGB), string = varuint byte length + UTF-8,
//     bool = one byte.
//   - Type and property keys: include/rive/generated/*_base.hpp.
//
// Structure is implicit in object order: Backboard, then each Artboard
// followed by its components; parentId and KeyedObject.objectId are indices
// within the artboard (the artboard itself is 0). Animations follow the
// artboard's components (LinearAnimation > KeyedObject > KeyedProperty >
// KeyFrame*), then state machines. `buildArtboard` keeps those indices
// consistent and rejects a parent that does not come before its child.
var NemoRivFormat = (function () {
  'use strict';

  var MAJOR_VERSION = 7;

  // Type keys used by Nemo's exporters (subset of the runtime's 363 types).
  var TYPE = {
    Backboard: 23, Artboard: 1, Node: 2, Shape: 3, PointsPath: 16,
    StraightVertex: 5, CubicMirroredVertex: 35, CubicDetachedVertex: 6, CubicAsymmetricVertex: 34,
    Ellipse: 4, Rectangle: 7,
    Fill: 20, Stroke: 24, SolidColor: 18, LinearGradient: 22, RadialGradient: 17, GradientStop: 19, TrimPath: 47,
    LinearAnimation: 31, KeyedObject: 25, KeyedProperty: 26, KeyFrameDouble: 30, KeyFrameColor: 37,
    CubicEaseInterpolator: 28,
    RootBone: 41, Bone: 40, Skin: 43, Tendon: 44, Weight: 45, IKConstraint: 81,
    StateMachine: 53, StateMachineNumber: 56, StateMachineBool: 59, StateMachineTrigger: 58, StateMachineLayer: 57,
    EntryState: 63, AnyState: 62, ExitState: 64, AnimationState: 61, StateTransition: 65,
    BlendState1DInput: 76, BlendAnimation1D: 75,
  };

  // Property name -> [key, field type]. Names follow the runtime's, except
  // where two classes reuse a name for different keys (prefix noted).
  /** @type {Record<string, [number, 'uint'|'double'|'color'|'string'|'bool']>} */
  var PROP = {
    name: [4, 'string'], parentId: [5, 'uint'],
    width: [7, 'double'], height: [8, 'double'], x: [13, 'double'], y: [14, 'double'],
    rotation: [15, 'double'], scaleX: [16, 'double'], scaleY: [17, 'double'], opacity: [18, 'double'],
    originX: [11, 'double'], originY: [12, 'double'],
    // Vertex / paths
    vertexX: [24, 'double'], vertexY: [25, 'double'], radius: [26, 'double'], isClosed: [32, 'bool'],
    mirrorRotation: [82, 'double'], mirrorDistance: [83, 'double'],
    inRotation: [84, 'double'], inDistance: [85, 'double'], outRotation: [86, 'double'], outDistance: [87, 'double'],
    asymRotation: [79, 'double'], asymInDistance: [80, 'double'], asymOutDistance: [81, 'double'],
    pathWidth: [20, 'double'], pathHeight: [21, 'double'], cornerRadiusTL: [31, 'double'],
    // Paint
    fillRule: [40, 'uint'], colorValue: [37, 'color'], thickness: [47, 'double'], cap: [48, 'uint'], join: [49, 'uint'],
    gradientStartX: [42, 'double'], gradientStartY: [33, 'double'], gradientEndX: [34, 'double'], gradientEndY: [35, 'double'],
    gradientOpacity: [46, 'double'], stopColor: [38, 'color'], stopPosition: [39, 'double'],
    trimStart: [114, 'double'], trimEnd: [115, 'double'], trimOffset: [116, 'double'], trimMode: [117, 'uint'],
    // Animation
    animationName: [55, 'string'], fps: [56, 'uint'], duration: [57, 'uint'], speed: [58, 'double'], loop: [59, 'uint'],
    objectId: [51, 'uint'], propertyKey: [53, 'uint'], frame: [67, 'uint'],
    interpolationType: [68, 'uint'], interpolatorId: [69, 'uint'], keyValue: [70, 'double'], keyColor: [88, 'color'],
    cubicX1: [63, 'double'], cubicY1: [64, 'double'], cubicX2: [65, 'double'], cubicY2: [66, 'double'],
    // Bones, skinning, IK
    boneLength: [89, 'double'], rootX: [90, 'double'], rootY: [91, 'double'],
    skinXX: [104, 'double'], skinYX: [105, 'double'], skinXY: [106, 'double'], skinYY: [107, 'double'], skinTX: [108, 'double'], skinTY: [109, 'double'],
    boneId: [95, 'uint'], tendonXX: [96, 'double'], tendonYX: [97, 'double'], tendonXY: [98, 'double'], tendonYY: [99, 'double'], tendonTX: [100, 'double'], tendonTY: [101, 'double'],
    weightValues: [102, 'uint'], weightIndices: [103, 'uint'],
    strength: [172, 'double'], targetId: [173, 'uint'], invertDirection: [174, 'bool'], parentBoneCount: [175, 'uint'],
    // State machines
    stateMachineComponentName: [138, 'string'], numberValue: [140, 'double'], boolValue: [141, 'bool'],
    animationId: [149, 'uint'], stateToId: [151, 'uint'], transitionFlags: [152, 'uint'], transitionDuration: [158, 'uint'],
    blendInputId: [167, 'uint'], blendAnimationId: [165, 'uint'], blendValue: [166, 'double'],
  };

  /** Rive's interpolation types for KeyFrame.interpolationType. */
  var INTERPOLATION = { hold: 0, linear: 1, cubic: 2 };
  /** LinearAnimation.loop. */
  var LOOP = { oneShot: 0, loop: 1, pingPong: 2 };

  // ---- binary writer ----
  function Writer() { /** @type {number[]} */ this.bytes = []; }
  Writer.prototype.byte = function (v) { this.bytes.push(v & 255); };
  Writer.prototype.varuint = function (v) {
    if (!(v >= 0) || !isFinite(v) || Math.floor(v) !== v) throw new Error('varuint needs a non-negative integer, got ' + v);
    do { var b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 128; this.byte(b); } while (v > 0);
  };
  Writer.prototype.float32 = function (v) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('double needs a finite number, got ' + v);
    var dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, true);
    for (var i = 0; i < 4; i++) this.byte(dv.getUint8(i));
  };
  Writer.prototype.uint32 = function (v) {
    var dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, v >>> 0, true);
    for (var i = 0; i < 4; i++) this.byte(dv.getUint8(i));
  };
  Writer.prototype.string = function (s) {
    var utf8 = new TextEncoder().encode(String(s));
    this.varuint(utf8.length); for (var i = 0; i < utf8.length; i++) this.byte(utf8[i]);
  };

  /**
   * Encode a full .riv from an object list.
   * @param {Array<{type: string, props?: Record<string, number|string|boolean>}>} objects
   * @param {{fileId?: number, minorVersion?: number}} [opts]
   * @returns {Uint8Array}
   */
  function encode(objects, opts) {
    opts = opts || {};
    var w = new Writer();
    'RIVE'.split('').forEach(function (c) { w.byte(c.charCodeAt(0)); });
    w.varuint(MAJOR_VERSION); w.varuint(opts.minorVersion || 0); w.varuint(opts.fileId || 0);
    w.varuint(0); // empty property ToC: every key written is one the runtime knows
    objects.forEach(function (o, index) {
      var typeKey = TYPE[o.type];
      if (typeKey === undefined) throw new Error('object ' + index + ': unknown Rive type "' + o.type + '"');
      w.varuint(typeKey);
      var props = o.props || {};
      Object.keys(props).forEach(function (name) {
        var value = props[name]; if (value === undefined) return;
        var def = PROP[name];
        if (!def) throw new Error('object ' + index + ' (' + o.type + '): unknown property "' + name + '"');
        w.varuint(def[0]);
        switch (def[1]) {
          case 'uint': w.varuint(/** @type {number} */ (value)); break;
          case 'double': w.float32(/** @type {number} */ (value)); break;
          case 'color': w.uint32(/** @type {number} */ (value)); break;
          case 'string': w.string(value); break;
          case 'bool': w.byte(value ? 1 : 0); break;
        }
      });
      w.varuint(0);
    });
    return new Uint8Array(w.bytes);
  }

  /** '#rrggbb' or '#rrggbbaa' (Nemo's hex8) -> Rive ARGB uint32. */
  function colorFromHex(hex) {
    var h = String(hex).replace('#', '');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error('colour must be #rrggbb or #rrggbbaa, got ' + hex);
    var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return ((a << 24) | parseInt(h.slice(0, 6), 16)) >>> 0;
  }

  /** Pack four bytes (bone indices or weights out of 255) into one uint, as Weight expects. */
  function pack4(a) { return ((a[0] & 255) | ((a[1] & 255) << 8) | ((a[2] & 255) << 16) | ((a[3] & 255) << 24)) >>> 0; }

  /**
   * Artboard builder that keeps artboard-local indices consistent.
   * add() returns the new component's index, for parentId/objectId/boneId/targetId.
   */
  function buildArtboard(name, width, height) {
    var components = [{ type: 'Artboard', props: { name: name, width: width, height: height } }];
    /** @type {Array<{props: object, keyed: Array<{objectId: number, propertyKey: number, frames: Array<object>}>}>} */
    var animations = [];
    var stateMachines = [];
    return {
      add: function (type, props) {
        if (TYPE[type] === undefined) throw new Error('unknown Rive type "' + type + '"');
        var p = props || {};
        if (p.parentId !== undefined && !(p.parentId >= 0 && p.parentId < components.length)) {
          throw new Error(type + ': parentId ' + p.parentId + ' must refer to an earlier component (0..' + (components.length - 1) + ')');
        }
        components.push({ type: type, props: p });
        return components.length - 1;
      },
      animation: function (animName, o) {
        o = o || {};
        var anim = { props: { animationName: animName, fps: o.fps || 60, duration: o.duration || 60, loop: o.loop === undefined ? LOOP.loop : o.loop }, keyed: [] };
        animations.push(anim);
        var api = {
          index: animations.length - 1,
          /** frames: [{frame, value | color, interpolation?}] */
          key: function (objectId, property, frames) {
            if (!(objectId >= 0 && objectId < components.length)) throw new Error('key: objectId ' + objectId + ' is not a component of this artboard');
            var def = PROP[property]; if (!def) throw new Error('key: unknown property "' + property + '"');
            anim.keyed.push({ objectId: objectId, propertyKey: def[0], frames: frames });
            return api;
          },
        };
        return api;
      },
      /** Raw state machine objects, written after the animations in order (see the Rive importers). */
      stateMachine: function (objects) { stateMachines.push.apply(stateMachines, objects); },
      objects: function () {
        var out = components.slice();
        animations.forEach(function (a) {
          out.push({ type: 'LinearAnimation', props: a.props });
          a.keyed.forEach(function (k) {
            out.push({ type: 'KeyedObject', props: { objectId: k.objectId } });
            out.push({ type: 'KeyedProperty', props: { propertyKey: k.propertyKey } });
            k.frames.forEach(function (f) {
              var interp = INTERPOLATION[f.interpolation || 'linear'];
              out.push(f.color !== undefined
                ? { type: 'KeyFrameColor', props: { frame: f.frame, interpolationType: interp, keyColor: f.color } }
                : { type: 'KeyFrameDouble', props: { frame: f.frame, interpolationType: interp, keyValue: f.value } });
            });
          });
        });
        return out.concat(stateMachines);
      },
    };
  }

  /** One-artboard file. */
  function encodeArtboard(artboard, opts) { return encode([{ type: 'Backboard' }].concat(artboard.objects()), opts); }

  return {
    TYPE: TYPE, PROP: PROP, INTERPOLATION: INTERPOLATION, LOOP: LOOP, MAJOR_VERSION: MAJOR_VERSION,
    encode: encode, encodeArtboard: encodeArtboard, buildArtboard: buildArtboard,
    colorFromHex: colorFromHex, pack4: pack4,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = NemoRivFormat;
