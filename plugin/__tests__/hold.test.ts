import {PenRest, RestGate} from '../src/hold';

const ev = (action: number, x: number, t: number, down = 1000, toolType = 2) => ({action, x, y: 100, eventTime: t, downTime: down, toolType});

describe('pen rest', () => {
  it('measures how long the pen stayed still before lifting', () => {
    const pen = new PenRest(() => 12);
    pen.feed(ev(0, 0, 1000));
    pen.feed(ev(2, 50, 1100));
    pen.feed(ev(2, 100, 1200)); // last real movement
    pen.feed(ev(2, 105, 1800)); // jitter within the radius
    expect(pen.penDown).toBe(true);
    expect(pen.feed(ev(1, 106, 2500))).toBe(1300);
    expect(pen.penDown).toBe(false);
  });

  it('ignores fingers and resolves waiters when the pen lifts', async () => {
    const pen = new PenRest(() => 12);
    expect(pen.feed(ev(0, 0, 1000, 1000, 1))).toBeNull();
    pen.feed(ev(0, 0, 1000));
    let lifted = false;
    const p = pen.whenLifted().then(() => (lifted = true));
    expect(lifted).toBe(false);
    pen.feed(ev(1, 0, 1100));
    await p;
    expect(lifted).toBe(true);
  });

  it('pairs a long rest with an ink stroke, in either order', () => {
    const gate = new RestGate(() => 1200);
    expect(gate.onLift(1500, 10_000)).toBe(false);
    expect(gate.onStroke(10, 10_050)).toBe(true);
    expect(gate.onStroke(10, 20_000)).toBe(false);
    expect(gate.onLift(1300, 20_010)).toBe(true);
  });

  it('ignores short rests, lasso paths, stale pairs and the off switch', () => {
    const gate = new RestGate(() => 1200);
    gate.onLift(400, 1000);
    expect(gate.onStroke(10, 1010)).toBe(false);
    gate.onLift(2000, 2000);
    expect(gate.onStroke(4, 2010)).toBe(false); // lasso
    gate.onLift(2000, 3000);
    expect(gate.onStroke(10, 9000)).toBe(false); // too far apart
    const off = new RestGate(() => 0);
    off.onLift(5000, 1000);
    expect(off.onStroke(10, 1001)).toBe(false);
  });
});
