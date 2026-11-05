'use strict';
// Rive .riv writer (domain/export/riv-format.js).
//
// Expectations come from outside the module:
//   * golden bytes for a minimal file, computed by hand from the format
//     (rive-runtime include/rive/runtime_header.hpp, src/file.cpp
//     readRuntimeObject, src/core/field_types/*.cpp);
//   * an independent decoder written here from the same description, used to
//     read back larger files;
//   * type and property keys pinned to the values in rive-runtime's
//     include/rive/generated/*_base.hpp (checked against the headers when
//     this test was written; a change upstream should be a conscious edit).
// That the output plays in Rive's own runtime was checked separately in a
// browser with @rive-app/canvas 2.20.0 (the version the Construct "Rive
// Loader" addon bundles); that check is not part of `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const Riv = require('../src/js/domain/export/riv-format.js');

// ---- independent decoder (spec, not module) ----
const FIELD = { // property key -> field type, for the keys these tests write
  4: 'string', 5: 'uint', 7: 'double', 8: 'double', 13: 'double', 14: 'double', 15: 'double', 16: 'double', 17: 'double',
  24: 'double', 25: 'double', 26: 'double', 32: 'bool', 37: 'color', 40: 'uint', 47: 'double', 51: 'uint', 53: 'uint',
  55: 'string', 56: 'uint', 57: 'uint', 59: 'uint', 67: 'uint', 68: 'uint', 70: 'double', 88: 'color',
  89: 'double', 90: 'double', 91: 'double', 102: 'uint', 103: 'uint', 138: 'string', 140: 'double', 151: 'uint',
  165: 'uint', 166: 'double', 167: 'uint', 173: 'uint', 175: 'uint',
};
function decode(bytes) {
  let i = 0;
  const byte = () => { if (i >= bytes.length) throw new Error('read past end'); return bytes[i++]; };
  const varuint = () => { let v = 0, m = 1, b; do { b = byte(); v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f32 = () => { const v = dv.getFloat32(i, true); i += 4; return v; };
  const u32 = () => { const v = dv.getUint32(i, true); i += 4; return v; };
  const str = () => { const n = varuint(); const s = new TextDecoder().decode(bytes.slice(i, i + n)); i += n; return s; };
  const magic = String.fromCharCode(byte(), byte(), byte(), byte());
  const header = { magic, major: varuint(), minor: varuint(), fileId: varuint() };
  const toc = []; for (let k = varuint(); k !== 0; k = varuint()) toc.push(k);
  if (toc.length) { for (let n = 0; n < Math.ceil(toc.length / 16); n++) u32(); }
  const objects = [];
  while (i < bytes.length) {
    const typeKey = varuint(); const props = {};
    for (let key = varuint(); key !== 0; key = varuint()) {
      const t = FIELD[key]; if (!t) throw new Error('test decoder: unexpected key ' + key);
      props[key] = t === 'uint' ? varuint() : t === 'double' ? f32() : t === 'color' ? u32() : t === 'bool' ? byte() !== 0 : str();
    }
    objects.push({ typeKey, props });
  }
  return { header, toc, objects };
}

test('minimal file matches hand-computed bytes', () => {
  const bytes = Riv.encode([{ type: 'Backboard' }, { type: 'Artboard', props: { name: 'A', width: 1, height: 2 } }]);
  const expected = [
    0x52, 0x49, 0x56, 0x45, // "RIVE"
    7, 0, 0,                // major 7, minor 0, file id 0
    0,                      // empty property ToC
    23, 0,                  // Backboard, no properties
    1,                      // Artboard
    4, 1, 0x41,             //   name (key 4): length 1, "A"
    7, 0x00, 0x00, 0x80, 0x3f, //   width (key 7): float32 1.0 LE
    8, 0x00, 0x00, 0x00, 0x40, //   height (key 8): float32 2.0 LE
    0,                      //   end of object
  ];
  assert.deepEqual(Array.from(bytes), expected);
});

test('varuint uses 7-bit groups, low first', () => {
  // KeyedObject.objectId = 300 -> 0xAC 0x02; 16384 -> 0x80 0x80 0x01
  const a = decode(Riv.encode([{ type: 'KeyedObject', props: { objectId: 300 } }]));
  assert.equal(a.objects[0].props[51], 300);
  const raw = Riv.encode([{ type: 'KeyedObject', props: { objectId: 16384 } }]);
  assert.deepEqual(Array.from(raw.slice(-5)), [51, 0x80, 0x80, 0x01, 0]);
});

test('type and property keys match rive-runtime headers', () => {
  // include/rive/generated/*_base.hpp typeKey values
  const types = { Backboard: 23, Artboard: 1, Node: 2, Shape: 3, PointsPath: 16, StraightVertex: 5, CubicMirroredVertex: 35,
    Ellipse: 4, Rectangle: 7, Fill: 20, Stroke: 24, SolidColor: 18, LinearAnimation: 31, KeyedObject: 25, KeyedProperty: 26,
    KeyFrameDouble: 30, KeyFrameColor: 37, RootBone: 41, Bone: 40, Skin: 43, Tendon: 44, Weight: 45, IKConstraint: 81,
    StateMachine: 53, StateMachineNumber: 56, StateMachineLayer: 57, EntryState: 63, AnyState: 62, ExitState: 64,
    StateTransition: 65, BlendState1DInput: 76, BlendAnimation1D: 75 };
  for (const [name, key] of Object.entries(types)) assert.equal(Riv.TYPE[name], key, name);
  // namePropertyKey 4 (component_base), x/y 13/14 (node_base), rotation 15, scaleX/Y 16/17 (transform_component_base),
  // vertex x/y 24/25 (vertex_base), colorValue 37 (solid_color_base), objectId 51, propertyKey 53, frame 67, value 70,
  // boneLength 89, weight values/indices 102/103, targetId 173, parentBoneCount 175.
  const props = { name: 4, x: 13, y: 14, rotation: 15, scaleX: 16, scaleY: 17, vertexX: 24, vertexY: 25, colorValue: 37,
    objectId: 51, propertyKey: 53, frame: 67, keyValue: 70, boneLength: 89, weightValues: 102, weightIndices: 103,
    targetId: 173, parentBoneCount: 175, blendInputId: 167 };
  for (const [name, key] of Object.entries(props)) assert.equal(Riv.PROP[name][0], key, name);
});

test('artboard builder: indices, animation section and round-trip values', () => {
  const ab = Riv.buildArtboard('Nemo', 800, 600);
  const shape = ab.add('Shape', { name: 'Star', parentId: 0, x: 220, y: 240 });
  const path = ab.add('PointsPath', { parentId: shape, isClosed: true });
  ab.add('StraightVertex', { parentId: path, vertexX: -10.5, vertexY: 3, radius: 4 });
  const fill = ab.add('Fill', { parentId: shape });
  const color = ab.add('SolidColor', { parentId: fill, colorValue: Riv.colorFromHex('#ffb86c') });
  ab.animation('loop', { fps: 24, duration: 48 })
    .key(shape, 'rotation', [{ frame: 0, value: 0 }, { frame: 48, value: Math.PI }])
    .key(color, 'colorValue', [{ frame: 0, color: Riv.colorFromHex('#ff0000') }, { frame: 24, color: Riv.colorFromHex('#00ff0080'), interpolation: 'hold' }]);
  const { header, toc, objects } = decode(Riv.encodeArtboard(ab));
  assert.deepEqual(header, { magic: 'RIVE', major: 7, minor: 0, fileId: 0 });
  assert.deepEqual(toc, []);
  const types = objects.map(o => o.typeKey);
  // Backboard, Artboard, Shape, PointsPath, StraightVertex, Fill, SolidColor, LinearAnimation,
  // KeyedObject, KeyedProperty, KeyFrameDouble ×2, KeyedObject, KeyedProperty, KeyFrameColor ×2
  assert.deepEqual(types, [23, 1, 3, 16, 5, 20, 18, 31, 25, 26, 30, 30, 25, 26, 37, 37]);
  assert.equal(objects[2].props[5], 0, 'shape parent is the artboard (index 0)');
  assert.equal(objects[3].props[5], 1, 'path parent is the shape (artboard index 1)');
  assert.equal(objects[3].props[32], true);
  assert.equal(objects[4].props[24], -10.5);
  assert.equal(objects[6].props[37], 0xffffb86c);
  assert.deepEqual([objects[7].props[55], objects[7].props[56], objects[7].props[57], objects[7].props[59]], ['loop', 24, 48, 1]);
  assert.equal(objects[8].props[51], shape);
  assert.equal(objects[9].props[53], 15, 'keyed property is rotation (key 15)');
  assert.ok(Math.abs(objects[11].props[70] - Math.PI) < 1e-6, 'float32 keeps pi to ~1e-7');
  assert.equal(objects[13].props[53], 37, 'keyed property is colorValue (key 37)');
  assert.equal(objects[15].props[88], 0x8000ff00, 'hex8 alpha goes to the top byte');
  assert.equal(objects[15].props[68], 0, 'hold interpolation');
});

test('bones, weights and a state machine encode in order', () => {
  const ab = Riv.buildArtboard('Rig', 100, 100);
  const root = ab.add('RootBone', { parentId: 0, rootX: 10, rootY: 20, boneLength: 30 });
  const tip = ab.add('Bone', { parentId: root, boneLength: 25 });
  const target = ab.add('Node', { parentId: 0, x: 50, y: 0 });
  ab.add('IKConstraint', { parentId: tip, targetId: target, parentBoneCount: 1 });
  const s = ab.add('Shape', { parentId: 0 }); const p = ab.add('PointsPath', { parentId: s });
  const v = ab.add('StraightVertex', { parentId: p, vertexX: 0, vertexY: 0 });
  ab.add('Weight', { parentId: v, weightValues: Riv.pack4([200, 55, 0, 0]), weightIndices: Riv.pack4([1, 2, 0, 0]) });
  ab.animation('poseA', { duration: 1, loop: Riv.LOOP.oneShot }).key(root, 'rotation', [{ frame: 0, value: 0.5 }]);
  ab.stateMachine([
    { type: 'StateMachine', props: { animationName: 'Rig' } },
    { type: 'StateMachineNumber', props: { stateMachineComponentName: 'turn', numberValue: 50 } },
    { type: 'StateMachineLayer', props: { stateMachineComponentName: 'Layer 1' } },
    { type: 'EntryState' }, { type: 'StateTransition', props: { stateToId: 3 } }, { type: 'AnyState' }, { type: 'ExitState' },
    { type: 'BlendState1DInput', props: { blendInputId: 0 } }, { type: 'BlendAnimation1D', props: { blendAnimationId: 0, blendValue: 0 } },
  ]);
  const { objects } = decode(Riv.encodeArtboard(ab));
  const weight = objects.find(o => o.typeKey === 45);
  assert.equal(weight.props[102], 200 | (55 << 8));
  assert.equal(weight.props[103], 1 | (2 << 8));
  const ik = objects.find(o => o.typeKey === 81);
  assert.deepEqual([ik.props[5], ik.props[173], ik.props[175]], [tip, target, 1]);
  const tail = objects.slice(-9).map(o => o.typeKey);
  assert.deepEqual(tail, [53, 56, 57, 63, 65, 62, 64, 76, 75], 'state machine follows the animations, in the given order');
  assert.equal(objects[objects.length - 8].props[138], 'turn');
});

test('rejects what a reader would silently misread', () => {
  assert.throws(() => Riv.encode([{ type: 'Spline' }]), /unknown Rive type "Spline"/);
  assert.throws(() => Riv.encode([{ type: 'Shape', props: { colour: 1 } }]), /unknown property "colour"/);
  assert.throws(() => Riv.encode([{ type: 'Shape', props: { x: NaN } }]), /finite number/);
  assert.throws(() => Riv.encode([{ type: 'Shape', props: { parentId: -1 } }]), /non-negative integer/);
  const ab = Riv.buildArtboard('A', 10, 10);
  assert.throws(() => ab.add('Shape', { parentId: 5 }), /must refer to an earlier component/);
  assert.throws(() => ab.animation('a').key(9, 'x', []), /not a component/);
  assert.throws(() => ab.animation('b').key(0, 'wobble', []), /unknown property "wobble"/);
  assert.throws(() => Riv.colorFromHex('red'), /#rrggbb/);
});

test('colorFromHex and pack4', () => {
  assert.equal(Riv.colorFromHex('#4a9eff'), 0xff4a9eff);
  assert.equal(Riv.colorFromHex('#4A9EFF00'), 0x004a9eff);
  assert.equal(Riv.pack4([1, 2, 3, 4]), 0x04030201);
  assert.equal(Riv.pack4([255, 255, 255, 255]), 0xffffffff);
});
