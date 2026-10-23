import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => process.env.CONTEXT_MODE_TEST_BASE
  ? execFileSync('git', ['show', `589d8214d56740a28b5f7bf63167743d586b0b40:${name}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, name), 'utf8');

test('runtime install, native rebuild and native heal scope bin-links to npm children', () => {
  for (const mode of ['install', 'rebuild', 'heal']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-mode-bin-links-'));
    try {
      fs.mkdirSync(path.join(dir, 'hooks'));
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(dir, 'hooks/ensure-deps.mjs'), source('hooks/ensure-deps.mjs'));
      fs.writeFileSync(path.join(dir, 'bin/npm'), '#!/bin/sh\nprintf "%s\\n" "$npm_config_bin_links:$npm_config_omit" >> "$NPM_ENV_LOG"\n', { mode: 0o755 });
      if (mode !== 'install') {
        fs.mkdirSync(path.join(dir, 'node_modules/better-sqlite3/build/Release'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules/better-sqlite3/package.json'), '{"version":"12.6.2"}');
      }
      let script = 'await import("./hooks/ensure-deps.mjs");';
      if (mode === 'heal') {
        fs.mkdirSync(path.join(dir, 'scripts'));
        fs.writeFileSync(path.join(dir, 'scripts/heal-better-sqlite3.mjs'), source('scripts/heal-better-sqlite3.mjs'));
        script = 'const m=await import("./scripts/heal-better-sqlite3.mjs"); m.healBetterSqlite3Binding(process.cwd());';
      }
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script + 'console.log(process.env.npm_config_bin_links+":"+process.env.npm_config_omit);'], {
        cwd: dir, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, npm_config_bin_links: 'true', npm_config_omit: 'optional', NPM_ENV_LOG: path.join(dir, 'npm-env.log') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(out.trim(), 'true:optional', `${mode} must not alter the host environment`);
      const calls = fs.readFileSync(path.join(dir, 'npm-env.log'), 'utf8').trim().split('\n');
      assert.ok(calls.length > 0, `${mode} must exercise npm`);
      assert.ok(calls.every((value) => value === 'false:dev'), `${mode}: ${calls}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('both startup npm spawn routes preserve the server environment', () => {
  const text = source('start.mjs');
  const begin = text.indexOf('{\n  const NPM_INSTALL_BG_PKGS');
  const end = text.indexOf('\n// Self-heal: create CLI shim', begin);
  assert.ok(begin >= 0 && end > begin);
  for (const useNodeCli of [false, true]) {
    const env = { npm_config_bin_links: 'true', npm_config_omit: 'optional', SENTINEL: 'kept' };
    const calls = [];
    vm.runInNewContext(text.slice(begin, end), {
      __dirname: '/plugin', resolve: path.resolve, dirname: path.dirname,
      process: { platform: 'linux', execPath: '/node', env, stderr: { write() {} } },
      existsSync: (p) => useNodeCli && p.endsWith('npm-cli.js'),
      spawn: (...args) => { calls.push(args); return { on() {}, unref() {} }; },
    });
    assert.equal(calls.length, 3);
    for (const [, , options] of calls) {
      assert.equal(options.env.npm_config_bin_links, 'false');
      assert.equal(options.env.npm_config_omit, 'dev');
      assert.equal(options.env.SENTINEL, 'kept');
      assert.notEqual(options.env, env);
    }
    assert.equal(env.npm_config_bin_links, 'true');
    assert.equal(env.npm_config_omit, 'optional');
  }
});


test('development startup invokes the installed TypeScript entry without npm bin links', () => {
  const text = source('start.mjs');
  const begin = text.indexOf('  // Dev or npm install — full build');
  const end = text.indexOf('\n  await import("./build/server.js");', begin);
  assert.ok(begin >= 0 && end > begin);
  const calls = [];
  vm.runInNewContext(text.slice(begin, end), {
    __dirname: '/plugin', resolve: path.resolve,
    process: { execPath: '/node', env: { npm_config_bin_links: 'true' } },
    existsSync: (p) => p === '/plugin/node_modules',
    execSync: (...args) => { calls.push({ kind: 'shell', args }); },
    execFileSync: (...args) => { calls.push({ kind: 'file', args }); },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'shell');
  assert.equal(calls[0].args[0], 'npm install --silent');
  assert.equal(calls[0].args[1].env.npm_config_omit, undefined);
  assert.equal(calls[1].kind, 'file');
  assert.equal(calls[1].args[0], '/node');
  assert.deepEqual(Array.from(calls[1].args[1]), ['/plugin/node_modules/typescript/bin/tsc']);
  assert.equal(calls[1].args[2].cwd, '/plugin');
  assert.equal(calls[1].args[2].timeout, 30000);
});
