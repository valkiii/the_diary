/**
 * Draws the stage: each layer's segments up to its pen position, at its
 * opacity. A segment is a thin rotated View, so no native drawing library is
 * needed. White, like the blank page beneath.
 */

import React, {memo, useEffect, useState} from 'react';
import {Pressable, StyleSheet, View, type LayoutChangeEvent} from 'react-native';

import {currentStage, subscribeStage, type Segment, type Stage} from './stage';

const Seg = memo(function Seg({s, k, w, color}: {s: Segment; k: number; w: number; color: string}) {
  const dx = (s.x2 - s.x1) * k;
  const dy = (s.y2 - s.y1) * k;
  const len = Math.hypot(dx, dy) + w; // overlap the joins
  return (
    <View
      style={[
        styles.seg,
        {
          left: ((s.x1 + s.x2) / 2) * k - len / 2,
          top: ((s.y1 + s.y2) / 2) * k - w / 2,
          width: len,
          height: w,
          borderRadius: w / 2,
          backgroundColor: color,
          transform: [{rotate: `${Math.atan2(dy, dx)}rad`}],
        },
      ]}
    />
  );
});

function drawnCount(segs: Segment[], pen: number): number {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].at <= pen) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export default function StageView({stage}: {stage: Stage}): React.JSX.Element {
  const [, redraw] = useState(0);
  const [scale, setScale] = useState(0);
  useEffect(() => subscribeStage(() => redraw(n => n + 1)), []);

  const onLayout = (e: LayoutChangeEvent) => setScale(e.nativeEvent.layout.width / stage.page.width);
  const w = Math.max(1, stage.width * scale);
  return (
    <Pressable style={styles.root} onLayout={onLayout} onPress={() => currentStage()?.onTap?.()}>
      {scale > 0 &&
        stage.layers.map((layer, li) =>
          layer.opacity > 0 ? (
            <View key={li} style={[StyleSheet.absoluteFill, {opacity: layer.opacity}]} pointerEvents="none">
              {layer.segs.slice(0, drawnCount(layer.segs, layer.pen)).map((s, i) => (
                <Seg key={i} s={s} k={scale} w={w} color={layer.color} />
              ))}
            </View>
          ) : null,
        )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  seg: {position: 'absolute'},
});
