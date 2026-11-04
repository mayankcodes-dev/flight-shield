import { describe, expect, it } from 'vitest';
import { flightShield } from '../src/index.js';

describe('flight-shield', () => {
  it('exports the package placeholder', () => {
    expect(flightShield).toBe('flight-shield');
  });
});
