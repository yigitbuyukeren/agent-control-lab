import { describe, expect, it } from 'vitest';
import { detectAuth, parseClaudeAuth, parseCodexAuth } from './auth.ts';
import { claudeCodeAdapter, codexAdapter, type Exec } from './providers.ts';

const out = (stdout: string, stderr = '') => ({ stdout, stderr });

describe('parseClaudeAuth', () => {
  it('parses subscription logins', () => {
    const json = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"a@b.co"}';
    expect(parseClaudeAuth(out(json))).toEqual({ state: 'logged-in', method: 'subscription', plan: 'max' });
  });
  it('parses api key logins and logged-out', () => {
    expect(parseClaudeAuth(out('{"loggedIn":true,"authMethod":"api_key"}'))).toEqual({
      state: 'logged-in',
      method: 'api-key',
    });
    expect(parseClaudeAuth(out('{"loggedIn":false}'))).toEqual({ state: 'logged-out' });
  });
  it('is unknown for unrecognised shapes and keeps odd plan values out', () => {
    expect(parseClaudeAuth(out('not json'))).toEqual({ state: 'unknown' });
    expect(parseClaudeAuth(out('{"foo":1}'))).toEqual({ state: 'unknown' });
    expect(parseClaudeAuth(out('{"loggedIn":true,"authMethod":"x"}'))).toEqual({
      state: 'logged-in',
      method: 'unknown',
    });
    expect(
      parseClaudeAuth(out('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"me@example.com"}')),
    ).toEqual({ state: 'logged-in', method: 'subscription' });
  });
});

describe('parseClaudeAuth: third-party providers', () => {
  it('never treats a non-firstParty provider as a subscription', () => {
    expect(parseClaudeAuth(out('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock","subscriptionType":"pro"}'))).toEqual({
      state: 'logged-in',
      method: 'third-party',
    });
    expect(parseClaudeAuth(out('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}'))).toMatchObject({
      method: 'subscription',
    });
  });
});

describe('parseCodexAuth', () => {
  it('parses known lines from stdout or stderr', () => {
    expect(parseCodexAuth(out('Logged in using ChatGPT\n'))).toEqual({ state: 'logged-in', method: 'subscription' });
    expect(parseCodexAuth(out('', 'Logged in using an API key - sk-***abc'))).toEqual({
      state: 'logged-in',
      method: 'api-key',
    });
    expect(parseCodexAuth(out('Not logged in'))).toEqual({ state: 'logged-out' });
  });
  it('is unknown otherwise', () => {
    expect(parseCodexAuth(out('something new'))).toEqual({ state: 'unknown' });
  });
});

describe('detectAuth', () => {
  const run = (adapter: typeof codexAdapter, exec: Exec) => detectAuth(adapter, exec, 1000);

  it('runs only the status command', async () => {
    let seen: unknown[] = [];
    const exec: Exec = (cmd, args) => {
      seen = [cmd, args];
      return Promise.resolve({ kind: 'ok', stdout: 'Logged in using ChatGPT' });
    };
    expect(await run(codexAdapter, exec)).toMatchObject({ state: 'logged-in', method: 'subscription' });
    expect(seen).toEqual(['codex', ['login', 'status']]);
    await run(claudeCodeAdapter, exec);
    expect(seen).toEqual(['claude', ['auth', 'status']]);
  });

  it('maps not-found, timeout, failures and unknown output', async () => {
    const as = (r: Awaited<ReturnType<Exec>>) => run(codexAdapter, () => Promise.resolve(r));
    expect(await as({ kind: 'not-found' })).toMatchObject({ state: 'not-installed' });
    expect(await as({ kind: 'timeout' })).toMatchObject({ state: 'error', error: 'timed out after 1000 ms' });
    expect(await as({ kind: 'failed', detail: 'boom me@example.com', stdout: 'garbage' })).toMatchObject({
      state: 'error',
      error: 'status command failed',
    });
    expect(await as({ kind: 'failed', detail: 'x', stdout: 'Not logged in' })).toMatchObject({
      state: 'logged-out',
    });
    expect(await as({ kind: 'ok', stdout: 'new format' })).toMatchObject({ state: 'unknown' });
    expect(await run(codexAdapter, () => Promise.reject(new Error('spawn me@example.com')))).toMatchObject({
      state: 'error',
      error: 'status check could not run',
    });
  });

  it('never carries raw output or emails in the status', async () => {
    const json = '{"loggedIn":true,"authMethod":"claude.ai","email":"secret@example.com","orgId":"o1"}';
    const status = await run(claudeCodeAdapter, () => Promise.resolve({ kind: 'ok', stdout: json }));
    expect(JSON.stringify(status)).not.toMatch(/secret|orgId|o1/);
  });
});
