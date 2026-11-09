// Lottie export: Motion baked into the exported strokes (used by export.js lottieBuild / lottiePathLayer).
// lottieBuild used to build every shape from the stored strokes (getEffectiveStrokesRendered) and never applied
// Motion, so a layer animated in Motion (position, rotation, scale, opacity), per-element Motion and parented layers
// exported frozen in every Lottie player and in Rive files converted from the Lottie. The PNG fallback
// (exportBuildFrame) applies element motion, then layer motion, then the parent chain; lottieBakeMotion bakes the same
// three, in the same order, into each stroke's vertices (lottieBuild's per-frame `sh` keys carry them), and keeps the
// resulting opacity in sd.__lottieOp and the stroke width in sd.strokeWidth for lottieMotionGroup to animate.
function lottieBakeMotion(li, f, strokes) {
  if (typeof SMMotion === 'undefined' || !strokes.length) return strokes;
  var lm = SMMotion.layerMotionAt(li, f), chain = SMMotion.parentChainMats(li, f) || [], lb = userLayers[li] && userLayers[li].bounds;
  var lp = lm && lb ? { x: lb.center.x + lm.ax, y: lb.center.y + lm.ay } : null;
  return strokes.map(function (sd) {
    var em = sd.strokeId ? SMMotion.elementMotionAt(li, sd.strokeId, f, sd) : null;
    if (!sd.segments || !sd.segments.length || (!em && !lp && !chain.length)) return sd;
    var out = JSON.parse(JSON.stringify(sd)), op = 1, sw = 1;
    // Paper's item.scale(sx, sy, pivot) → rotate(rot, pivot) → translate(dx, dy), as exportBuildFrame calls them
    function apply(m, pv) {
      var a = m.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      function v(x, y) { x *= m.sx; y *= m.sy; return [x * c - y * s, x * s + y * c]; }
      out.segments.forEach(function (g) {
        var q = v(g.point[0] - pv.x, g.point[1] - pv.y); g.point = [pv.x + q[0] + m.dx, pv.y + q[1] + m.dy];
        if (g.handleIn) g.handleIn = v(g.handleIn[0], g.handleIn[1]);
        if (g.handleOut) g.handleOut = v(g.handleOut[0], g.handleOut[1]);
      });
      op *= m.op; sw *= (Math.abs(m.sx) + Math.abs(m.sy)) / 2;
    }
    if (em) {
      var ec = new Path({ segments: out.segments.map(function (g) { return new Segment(g.point, g.handleIn, g.handleOut); }), closed: out.closed, insert: false }).bounds.center;
      apply(em, { x: ec.x + em.ax, y: ec.y + em.ay });
    }
    if (lp) apply(lm, lp);
    chain.forEach(function (pc) { apply(pc.mat, pc.pivot); });
    out.__lottieOp = op; if (out.strokeWidth) out.strokeWidth *= sw;
    return out;
  });
}
// The group's transform item for lottiePathLayer, with the baked opacity animated (and the stroke width on the `st`
// item) when they vary over the run; static otherwise, exactly as before.
function lottieMotionGroup(shapeItems, runStrokes, runStart, runEnd) {
  function keys(fn) {
    var k = [], seen = {};
    for (var rf = runStart; rf <= runEnd; rf++) { var val = fn(runStrokes[rf]); seen[val] = 1; k.push({ t: rf, s: [val] }); }
    return Object.keys(seen).length > 1 ? { a: 1, k: k } : { a: 0, k: k[0].s[0] };
  }
  shapeItems.forEach(function (it) { if (it.ty === 'st') it.w = keys(function (sd) { return sd.strokeWidth || 2; }); });
  return { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 },
    o: keys(function (sd) { return Math.round((sd.__lottieOp != null ? sd.__lottieOp : 1) * 10000) / 100; }) };
}
