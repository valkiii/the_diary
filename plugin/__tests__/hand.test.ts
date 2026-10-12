import * as fs from 'fs';
import {inkLine, layout, measure, normalizeText, toIntPoints, wrap} from '../src/hand/layout';

describe('hand layout', () => {
  it('wraps a reply to the column width', () => {
    const lines = wrap('Do you know anything about the Chamber of Secrets? Tell me everything.', 110, 1500);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      expect(measure(l, 110)).toBeLessThanOrEqual(1500);
    }
  });

  it('keeps accented letters and swaps curly quotes', () => {
    expect(normalizeText('Ça va, l’ami ? Perché')).toBe("Ça va, l'ami ? Perché");
  });

  it('joins strokes within a word into fewer polylines', () => {
    const word = inkLine('remember', 0, 100, 110);
    expect(word.length).toBeGreaterThan(0);
    expect(word.length).toBeLessThan(20);
    const pts = word.flat();
    expect(Math.min(...pts.map(p => p.x))).toBeGreaterThan(-60);
    expect(Math.max(...pts.map(p => p.y))).toBeLessThan(100 + 80);
  });

  it('lays out lines top-down inside the box', () => {
    const laid = layout('Hello, Harry. How wonderful to meet you at last. I have waited such a long time.', {left: 160, top: 300, width: 1600}, 110);
    expect(laid.lines.length).toBeGreaterThanOrEqual(2);
    expect(laid.bottom).toBeGreaterThan(300);
    const all = laid.lines.flat(2);
    expect(Math.min(...all.map(p => p.y))).toBeGreaterThan(250);
    expect(Math.max(...all.map(p => p.x))).toBeLessThan(160 + 1600 + 80);
    if (process.env.PREVIEW) {
      const paths = laid.lines.flat().map(l => `<polyline fill="none" stroke="#222" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${toIntPoints(l).map(p => `${p.x},${p.y}`).join(' ')}"/>`);
      fs.writeFileSync(process.env.PREVIEW, `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="${Math.ceil(laid.bottom + 100)}"><rect width="100%" height="100%" fill="#fff"/>${paths.join('')}</svg>`);
      console.log(`elements: ${laid.lines.flat().length}`);
    }
  });
});

describe('stage', () => {
  it('stamps segments with pen distance in writing order', () => {
    const {segments} = require('../src/stage');
    const {segs, total} = segments([[{x: 0, y: 0}, {x: 3, y: 4}, {x: 3, y: 10}], [{x: 10, y: 0}, {x: 10, y: 5}]]);
    expect(segs.map((s: any) => s.at)).toEqual([5, 11, 17]);
    expect(total).toBe(18);
  });

  it('groups a laid-out reply into words', () => {
    const laid = layout('Tell me everything, Harry.', {left: 0, top: 0, width: 5000}, 110);
    expect(laid.words.length).toBe(4);
    expect(laid.words.flat().length).toBe(laid.lines.flat().length);
  });
});
