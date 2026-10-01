import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_BACKENDS,
  detectBackendFromApiKey,
  isGoogleApiKey,
} from '../lib/provider-router.mjs';
import { parseApiKeys } from '../lib/google-key-pool.mjs';

test('accepts new Google AQ authorization keys', () => {
  const key = 'AQ.test-example-key';
  assert.equal(isGoogleApiKey(key), true);
  assert.equal(detectBackendFromApiKey(key), PROVIDER_BACKENDS.GOOGLE);
});

test('continues accepting legacy Google AIza keys', () => {
  const key = 'AIzaSyExampleLegacyKey';
  assert.equal(isGoogleApiKey(key), true);
  assert.equal(detectBackendFromApiKey(key), PROVIDER_BACKENDS.GOOGLE);
});

test('does not classify Vercel keys as Google keys', () => {
  assert.equal(isGoogleApiKey('vck_example'), false);
  assert.equal(detectBackendFromApiKey('vck_example'), PROVIDER_BACKENDS.VERCEL);
});

test('rotates multiple AQ keys just like legacy keys', () => {
  assert.deepEqual(
    parseApiKeys('AQ.first-key, AQ.second-key\nAQ.first-key'),
    ['AQ.first-key', 'AQ.second-key'],
  );
});
