// Paint inside — Draw mode "Inside" (brush tool, Properties ▸ Draw mode).
// Hooked from the two brush commit paths (draw-bridge.js commitStroke,
// tools.js Paper fallback) right after the Behind placement, as the global
// paintInsideClip(path, layer) (classic script, like trimStrokeEnds).
// A freshly committed stroke keeps only the part that lies over the layer's
// EXISTING filled shapes (Procreate's "clip to shape": shade a character
// without spilling). Destructive at commit time, like Behind: the result is
// ordinary geometry, so save/undo/export/tween see nothing new. Shapes =
// visible filled items of the layer, minus vector-brush ribbons, texture
// dabs, masks and duplicator copies (a ribbon is a line, not a shape).
// Returns the item that now stands for the stroke (first piece), the stroke
// itself when nothing could be clipped, or null when nothing was inside.
function paintInsideShapes(layer,exclude){
  return layer.children.filter(function(c){
    if(exclude.indexOf(c)>=0)return false;
    if(!(c instanceof Path||c instanceof CompoundPath))return false;
    var d=c.data||{};
    if(d.isVectorBrush||d.isBrushTextureCopy||d.isMask||d.isDuplicatorCopy)return false;
    if(!c.fillColor||c.fillColor.alpha===0||c.opacity===0||!c.visible)return false;
    return true;
  });
}
function paintInsideClip(path,layer){
  if(!path||!layer||path.parent!==layer)return path;
  // Texture dabs / bitmap companions are re-stamped from the anchor later
  // (tweens, reload): clipping them here would not survive. Not supported yet.
  if(path.data&&(path.data.brushCompanions||path.data.brushGroupId))return path;
  var own=[path];if(path.data&&path.data.linkedFill)own.push(path.data.linkedFill);
  var shapes=paintInsideShapes(layer,own);
  if(!shapes.length)return path; // nothing to paint inside: keep the stroke as drawn
  var mask=shapes[0].clone({insert:false});
  for(var i=1;i<shapes.length;i++){var u=mask.unite(shapes[i],{insert:false});mask=u;}
  var first=null;
  own.forEach(function(it){
    var isArea=it.closed||(it.data&&it.data.isVectorBrush)||(!it.strokeColor&&it.fillColor);
    var at=layer.children.indexOf(it),src=it.data,r;
    if(isArea){
      r=it.intersect(mask,{insert:false});
      it.remove();
      if(!r||r.isEmpty())return;
      r.data={}; // Paper copies the source data onto a boolean result: drop ribbon tags (isVectorBrush/centerSegments would rebuild it)
      var pieces;
      // One piece: insert as is. insertBooleanResult's degenerate-loop cleanup
      // (_eraseDegenerateSelfLoops, 1.5px revisit tolerance) eats a dense brush
      // ribbon whose two edges run close together: measured 291px -> 4px.
      if(r instanceof Path){r.fillColor=it.fillColor;r.strokeColor=it.strokeColor;if(it.strokeColor){r.strokeWidth=it.strokeWidth;r.strokeCap=it.strokeCap;r.strokeJoin=it.strokeJoin;}r.opacity=it.opacity;carryBooleanData(r,src,true);layer.insertChild(at,r);pieces=[r];}
      else pieces=insertBooleanResult(layer,at,r,it.fillColor,it.opacity,it.strokeColor?{color:it.strokeColor,width:it.strokeWidth,cap:it.strokeCap,join:it.strokeJoin}:null,src);
      if(!first&&pieces.length)first=pieces[0];
    }else{
      // Open line: clip as a line (trace:false keeps only the curve pieces
      // inside), then split the pieces into plain Paths (CLAUDE.md §1: never
      // insert a raw boolean result).
      r=it.intersect(mask,{insert:false,trace:false});
      it.remove();
      if(!r||r.isEmpty())return;
      var parts=r instanceof CompoundPath?r.children.slice():[r];
      parts.forEach(function(pc,k){
        pc.remove();pc.closed=false;pc.style=it.style;pc.opacity=it.opacity;pc.data={};
        carryBooleanData(pc,src,k===0);
        layer.insertChild(at+k,pc);
        if(!first)first=pc;
      });
    }
  });
  return first;
}
