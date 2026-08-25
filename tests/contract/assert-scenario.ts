import { expect } from 'vitest';
import type { CollectedStream } from '../helpers.js';
import { T1_TEXT, T2_TEXT, WEATHER_ARGS } from './wire-fixtures.js';

/**
 * The cross-provider normalized contract for the scripted scenario.
 * Every adapter must satisfy this EXACTLY - this is the Phase 1 exit bar.
 */
export function assertScenario(t1: CollectedStream, t2: CollectedStream): void {
  // Turn 1: text, then exactly one well-formed tool call, finish(tool_calls).
  expect(t1.text).toBe(T1_TEXT);
  const starts = t1.events.filter((e) => e.type === 'tool_call_start');
  const ends = t1.events.filter((e) => e.type === 'tool_call_end');
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(t1.calls).toHaveLength(1);

  const call = t1.calls[0];
  expect(call.id.length).toBeGreaterThan(0);
  expect(call.name).toBe('get_weather');
  expect(call.arguments).toEqual(WEATHER_ARGS);

  expect(t1.finishes).toEqual(['tool_calls']);
  expect(t1.usages[0]?.inputTokens).toBeGreaterThan(0);
  expect(t1.usages[0]?.outputTokens).toBeGreaterThan(0);

  // Turn 2: plain text answer, finish(stop).
  expect(t2.text).toBe(T2_TEXT);
  expect(t2.calls).toHaveLength(0);
  expect(t2.finishes).toEqual(['stop']);
  expect(t2.usages[0]?.inputTokens).toBeGreaterThan(0);
  expect(t2.usages[0]?.outputTokens).toBeGreaterThan(0);
}
