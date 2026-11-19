import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspect, applySteps, patchSettings, normalizeSource, readSource, bundledHelperVersion, HELPER_CLASSES, ICF_INSTALLER,
} from '../bw-api-patch/install.mjs';

const ACCEPT = 'application/vnd.sap.bw.modeling.adso-v1_2_0+xml';
const httpError = (method, url, code) => new Error(`${method} ${url} → HTTP ${code}`);

/**
 * A BW system as far as the installer sees it: classes with inactive and active source, the
 * ICF node, and the header defect. Records every write.
 */
function fakeBw({ active = {}, icf = false, headerOk = true, classrun = 'SUCCESS: /sap/bc/zbwmcp activated with ZCL_BWMCP_HTTP' } = {}) {
  const state = { active: { ...active }, inactive: {}, icf, writes: [] };
  const name = (url) => url.match(/\/oo\/classes\/([a-z0-9_]+)/)?.[1]?.toUpperCase();
  return {
    state,
    async getCsrfToken() { return 'token'; },
    async rawGet(url) {
      if (url.startsWith('/sap/bw/modeling/adso/')) throw httpError('GET', url, headerOk ? 404 : 406);
      if (url === '/sap/bc/zbwmcp') {
        if (!state.icf) throw httpError('GET', url, 404);
        return { body: JSON.stringify({ service: 'bwmcp', version: bundledHelperVersion() }) };
      }
      const cls = name(url);
      if (cls && url.includes('version=active')) {
        if (!(cls in state.active)) throw httpError('GET', url, 404);
        return { body: state.active[cls].replace(/\n/g, '\r\n') };
      }
      throw httpError('GET', url, 500);
    },
    async rawPost(url, body) {
      state.writes.push(['POST', url]);
      if (url.startsWith('/sap/bc/adt/oo/classrun/')) {
        if (/SUCCESS/.test(classrun)) state.icf = true;
        return { body: classrun };
      }
      if (url.startsWith('/sap/bc/adt/oo/classes')) {
        const cls = body.match(/adtcore:name="([A-Z0-9_]+)"/)[1];
        assert.match(body, /adtcore:packageRef adtcore:name="\$TMP"/);
        state.inactive[cls] = '';
        return { body: '' };
      }
      throw httpError('POST', url, 500);
    },
    async rawPut() { throw new Error('rawPut is for transports only'); },
    async rawDelete(url) {
      state.writes.push(['DELETE', url]);
      const cls = name(url);
      delete state.active[cls];
      delete state.inactive[cls];
      return { body: '' };
    },
    async adtLockClass(lower) { state.writes.push(['LOCK', lower]); return 'handle'; },
    async adtUnlockClass(lower) { state.writes.push(['UNLOCK', lower]); },
    async adtPutSource(lower, handle, source) { state.writes.push(['PUT', lower]); state.inactive[lower.toUpperCase()] = source; },
    async adtActivate(lower, upper) {
      state.writes.push(['ACTIVATE', upper]);
      if (upper in state.inactive) state.active[upper] = state.inactive[upper];
    },
  };
}

const options = { accept: ACCEPT, helperPath: '/sap/bc/zbwmcp', pkg: '$TMP' };
const settings = { pkg: '$TMP', transport: '', helperPath: '/sap/bc/zbwmcp' };
const installed = Object.fromEntries(HELPER_CLASSES.map((c) => [c.name, readSource(c.file)]));
const states = (steps) => steps.map((s) => `${s.label}:${s.state}`);

test('a complete installation is recognised although ADT returns other line endings', async () => {
  const steps = await inspect(fakeBw({ active: installed, icf: true }), options);
  assert.deepEqual(steps.map((s) => s.state), ['ok', 'ok', 'ok', 'ok']);
});

test('an empty system plans every part; a 406 marks the header exit as a manual step', async () => {
  const steps = await inspect(fakeBw({ headerOk: false }), options);
  assert.deepEqual(states(steps), [
    'Accept header enhancement (post-exit on CL_RSO_RES_RESOURCE):manual',
    'ZCL_BWMCP_DTP_FILTER:missing',
    'ZCL_BWMCP_HTTP:missing',
    'ICF service /sap/bc/zbwmcp:missing',
  ]);
});

test('a class whose source differs is planned as an update', async () => {
  const bw = fakeBw({ active: { ...installed, ZCL_BWMCP_HTTP: "CLASS zcl_bwmcp_http DEFINITION.\n  CONSTANTS c_version TYPE string VALUE '1.0.0'." }, icf: true });
  const steps = await inspect(bw, options);
  assert.equal(steps.find((s) => s.label === 'ZCL_BWMCP_HTTP').state, 'outdated');
  assert.equal(steps.find((s) => s.label === 'ZCL_BWMCP_DTP_FILTER').state, 'ok');
});

test('the header probe stays inconclusive when only media type 1.0.0 is published', async () => {
  const steps = await inspect(fakeBw({ active: installed, icf: true }), { ...options, accept: 'application/vnd.sap.bw.modeling.adso-v1_0_0+xml' });
  assert.equal(steps[0].state, 'unknown');
});

test('applying creates the classes in dependency order, sets up ICF and removes the installer class', async () => {
  const bw = fakeBw();
  const steps = await inspect(bw, options);
  const log = [];
  await applySteps(bw, steps, settings, (m) => log.push(m));
  assert.deepEqual(Object.keys(bw.state.active).sort(), ['ZCL_BWMCP_DTP_FILTER', 'ZCL_BWMCP_HTTP']);
  assert.equal(bw.state.icf, true);
  const activations = bw.state.writes.filter(([w]) => w === 'ACTIVATE').map(([, n]) => n);
  assert.deepEqual(activations, ['ZCL_BWMCP_DTP_FILTER', 'ZCL_BWMCP_HTTP', ICF_INSTALLER.name]);
  assert.ok(bw.state.writes.some(([w, url]) => w === 'DELETE' && url.includes('zcl_bwmcp_install')));
  assert.deepEqual((await inspect(bw, options)).map((s) => s.state), ['ok', 'ok', 'ok', 'ok']);
});

test('a failing ICF setup is reported, and the installer class is still removed', async () => {
  const bw = fakeBw({ active: installed, classrun: 'ERROR: insertion failed: 1 SICF 001' });
  const steps = await inspect(bw, options);
  await assert.rejects(applySteps(bw, steps, settings, () => {}), /ICF service setup failed: ERROR: insertion failed/);
  assert.ok(bw.state.writes.some(([w]) => w === 'DELETE'));
});

test('a transportable package needs a transport request', () => {
  assert.throws(() => patchSettings({ BW_PATCH_PACKAGE: 'ZBWMCP' }), /BW_PATCH_TRANSPORT/);
  assert.deepEqual(patchSettings({ BW_PATCH_PACKAGE: 'zbwmcp', BW_PATCH_TRANSPORT: 'bwdk900123' }),
    { pkg: 'ZBWMCP', transport: 'BWDK900123', helperPath: '/sap/bc/zbwmcp' });
  assert.equal(patchSettings({}).pkg, '$TMP');
});

test('the bundle is consistent: helper version, installer package placeholder, normalisation', () => {
  assert.match(bundledHelperVersion(), /^\d+\.\d+\.\d+$/);
  assert.match(readSource(ICF_INSTALLER.file), /c_package TYPE devclass VALUE '\$TMP'/);
  assert.equal(normalizeSource('A  \r\nB\r\n\r\n'), normalizeSource('A\nB'));
});
