/**
 * "Rest the pen": riddle commits the page after the pen has been still for a
 * moment. JS timers stall while a plugin's view is closed, so silence cannot be
 * timed here. What can be measured is the pen held still on the paper before
 * it lifts: motion events carry their own timestamps. Pure logic, unit-tested.
 */

export const TOOL_PEN = 2;
const DOWN = 0;
const UP = 1;
const CANCEL = 3;

export type Motion = {action: number; x: number; y: number; eventTime: number; downTime: number; toolType: number};

export class PenRest {
  /** A pen event has been seen: the host forwards motion events. */
  seen = false;
  penDown = false;
  private stroke = NaN;
  private anchor = {x: 0, y: 0};
  private anchorTime = 0;
  private lifted: (() => void)[] = [];

  constructor(private readonly radius: () => number) {}

  /** Feed a motion event. Returns how long the pen rested before lifting, on lift. */
  feed(e: Motion): number | null {
    if (e.toolType !== TOOL_PEN) {
      return null;
    }
    this.seen = true;
    if (e.action === DOWN || e.downTime !== this.stroke) {
      this.stroke = e.downTime;
      this.penDown = true;
      this.anchor = {x: e.x, y: e.y};
      this.anchorTime = e.eventTime;
    } else if (Math.hypot(e.x - this.anchor.x, e.y - this.anchor.y) > this.radius()) {
      this.anchor = {x: e.x, y: e.y};
      this.anchorTime = e.eventTime;
    }
    if (e.action === UP || e.action === CANCEL) {
      this.penDown = false;
      const waiting = this.lifted;
      this.lifted = [];
      waiting.forEach(fn => fn());
      return e.action === UP ? Math.max(0, e.eventTime - this.anchorTime) : 0;
    }
    return null;
  }

  /** Resolves once the pen is off the page (never edit under a moving pen). */
  whenLifted(): Promise<void> {
    if (!this.penDown) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.lifted.push(resolve));
  }
}

/**
 * The host sends the finished stroke (event_pen_up) and the motion UP
 * separately, in no promised order. A rest counts when both arrive close
 * together and the stroke was drawn with an ink pen (a lasso path is penType 4).
 */
export const INK_PEN_TYPES: readonly number[] = [1, 10, 11, 14, 15, 16];

export class RestGate {
  private rest: {ms: number; at: number} | null = null;
  private stroke: {penType: number | undefined; at: number} | null = null;

  constructor(private readonly holdMs: () => number, private readonly windowMs = 1500) {}

  onLift(restMs: number, now: number): boolean {
    this.rest = {ms: restMs, at: now};
    return this.check(now);
  }

  onStroke(penType: number | undefined, now: number): boolean {
    this.stroke = {penType, at: now};
    return this.check(now);
  }

  private check(now: number): boolean {
    const {rest, stroke} = this;
    if (!rest || !stroke || Math.abs(rest.at - stroke.at) > this.windowMs || now - Math.min(rest.at, stroke.at) > this.windowMs) {
      return false;
    }
    this.rest = null;
    this.stroke = null;
    const hold = this.holdMs();
    const ink = stroke.penType === undefined || INK_PEN_TYPES.includes(stroke.penType);
    return hold > 0 && rest.ms >= hold && ink;
  }
}
