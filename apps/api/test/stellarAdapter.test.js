const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const stellarAdapter = require('../src/wallet/stellar.adapter');
const { server } = require('../src/config/stellar');
const config = require('../src/config/env');

const USDC_ISSUER = config.stellar.usdcIssuer;
const OTHER_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';

test('createWallet returns a valid Stellar keypair', () => {
  const { publicKey, secretKey } = stellarAdapter.createWallet();
  assert.equal(typeof publicKey, 'string');
  assert.equal(publicKey[0], 'G');
  assert.equal(publicKey.length, 56);
  assert.equal(secretKey[0], 'S');
  assert.equal(stellarAdapter.validateAddress(publicKey), true);
});

test('validateAddress rejects non-Stellar input', () => {
  assert.equal(stellarAdapter.validateAddress('0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12'), false);
  assert.equal(stellarAdapter.validateAddress('not-an-address'), false);
  assert.equal(stellarAdapter.validateAddress(''), false);
  assert.equal(stellarAdapter.validateAddress(null), false);
  // Right shape, wrong checksum.
  assert.equal(stellarAdapter.validateAddress(`G${'A'.repeat(55)}`), false);
});

test('resolveAsset maps XLM/native and rejects unknown assets', () => {
  assert.equal(stellarAdapter.resolveAsset('XLM').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset('native').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset(undefined).isNative(), true);
  assert.throws(() => stellarAdapter.resolveAsset('DOGE'), /Unsupported asset/);
});

test('adapter identifies as the stellar chain', () => {
  assert.equal(stellarAdapter.chain, 'stellar');
});

afterEach(() => {
  mock.restoreAll();
});

test('getBalances returns XLM and USDC rows when both trustlines exist', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '42.5000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '10.0000000' },
    ],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [
    { asset: 'XLM', value: '42.5000000' },
    { asset: 'USDC', value: '10.0000000' },
  ]);
});

test('getBalances returns only XLM for an XLM-only account', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [{ asset_type: 'native', balance: '5.0000000' }],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [{ asset: 'XLM', value: '5.0000000' }]);
});

test('getBalances ignores a USDC-code trustline from an untrusted issuer', async () => {
  mock.method(server, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '1.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: OTHER_ISSUER, balance: '999.0000000' },
    ],
  }));

  const balances = await stellarAdapter.getBalances('GABCD');
  assert.deepEqual(balances, [{ asset: 'XLM', value: '1.0000000' }]);
});

test('resolveAsset returns USDC asset with correct issuer', () => {
  const asset = stellarAdapter.resolveAsset('USDC');
  assert.equal(asset.isNative(), false);
  assert.equal(asset.code, 'USDC');
  assert.equal(asset.issuer, USDC_ISSUER);
});

// --- establishTrustline tests (mocked Horizon) ---

const TEST_SECRET = 'SBRK3DKI4GG5RJKMY3XWHCEB5XTRK4RAPCHPBUIXZ6NBBRIV2OC7BWMR';
const TEST_PUBLIC = 'GBF3MTTGQTL2CAMKMQT7Y7CZKFQ4F2MWPJMPKK4K77CQUFL3RJ7FFNET';

test('establishTrustline creates trustline when account lacks it', async () => {
  let submittedTx = null;

  mock.method(server, 'loadAccount', async () => ({
    accountId: () => TEST_PUBLIC,
    sequenceNumber: () => '12345',
    incrementSequenceNumber: () => {},
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
  }));
  mock.method(server, 'fetchBaseFee', async () => 100);
  mock.method(server, 'submitTransaction', async (tx) => {
    submittedTx = tx;
    return { hash: 'abc123' };
  });

  const result = await stellarAdapter.establishTrustline({
    secretKey: TEST_SECRET,
    assetCode: 'USDC',
  });

  assert.deepEqual(result, { established: true, alreadyExisted: false });
  assert.ok(submittedTx, 'Transaction should have been submitted');
  assert.equal(submittedTx.operations.length, 1);
  assert.equal(submittedTx.operations[0].type, 'changeTrust');
  assert.equal(submittedTx.operations[0].line.code, 'USDC');
  assert.equal(submittedTx.operations[0].line.issuer, USDC_ISSUER);
});

test('establishTrustline returns alreadyExisted=true when trustline exists', async () => {
  mock.method(server, 'loadAccount', async () => ({
    accountId: () => TEST_PUBLIC,
    sequenceNumber: () => '12345',
    balances: [
      { asset_type: 'native', balance: '100.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '50.0000000' },
    ],
  }));
  const submitSpy = mock.method(server, 'submitTransaction', async () => ({ hash: 'abc123' }));

  const result = await stellarAdapter.establishTrustline({
    secretKey: TEST_SECRET,
    assetCode: 'USDC',
  });

  assert.deepEqual(result, { established: true, alreadyExisted: true });
  assert.equal(submitSpy.mock.calls.length, 0, 'Should not submit transaction when trustline exists');
});

test('establishTrustline throws readable error for unfunded account', async () => {
  const notFoundError = new Error('Not Found');
  notFoundError.response = { status: 404 };
  mock.method(server, 'loadAccount', async () => { throw notFoundError; });

  await assert.rejects(
    stellarAdapter.establishTrustline({ secretKey: TEST_SECRET, assetCode: 'USDC' }),
    { message: 'Account is not funded. Deposit XLM before establishing a trustline.' },
  );
});

test('establishTrustline rejects native XLM asset', async () => {
  await assert.rejects(
    stellarAdapter.establishTrustline({ secretKey: TEST_SECRET, assetCode: 'XLM' }),
    { message: 'Cannot establish trustline for native XLM.' },
  );
});
