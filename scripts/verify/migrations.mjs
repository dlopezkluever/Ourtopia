import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';

assert.deepEqual(process.argv.slice(2), ['--disposable-project', 'ourtopia-issue-2']);
const config = readFileSync('supabase/config.toml', 'utf8');
assert.ok(config.includes('project_id = "ourtopia-issue-2"'));
assert.ok(config.includes('port = 55322'));
const container = 'supabase_db_ourtopia-issue-2';
const bindings = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', container], { encoding: 'utf8' }));
assert.equal(bindings['5432/tcp'][0].HostPort, '55322', 'Reset target must be this disposable local database.');
const binary = process.execPath;
const run = args => execFileSync(binary, ['node_modules/supabase/dist/supabase.js', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sql = query => execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', query], { encoding: 'utf8' }).trim();
const outputs = [];
const predecessor = '.pilot-evidence/predecessor';
mkdirSync(`${predecessor}/supabase/migrations`, { recursive: true });
writeFileSync(`${predecessor}/supabase/config.toml`, config);
const services = ['auth', 'realtime', 'rest', 'storage', 'pg_meta', 'studio'].map(name => `supabase_${name}_ourtopia-issue-2`);
const stopServices = () => execFileSync('docker', ['stop', ...services], { encoding: 'utf8' });
try {
  stopServices();
  outputs.push(run(['db', 'reset', '--local']));
  assert.equal(sql("select count(*) from public.communities"), '0');
  stopServices();
  outputs.push(run(['db', 'reset', '--local', '--workdir', predecessor]));
  assert.equal(sql("select count(*) from pg_tables where schemaname = 'public' and tablename = 'communities'"), '0');
  sql("create table public.issue_2_upgrade_sentinel (value text); insert into public.issue_2_upgrade_sentinel values ('predecessor-data-survives')");
  outputs.push(run(['db', 'push', '--local']));
  assert.equal(sql('select value from public.issue_2_upgrade_sentinel'), 'predecessor-data-survives');
  assert.equal(sql("select count(*) from public.communities"), '0');
  sql('drop table public.issue_2_upgrade_sentinel');
} finally {
  execFileSync('docker', ['start', ...services], { encoding: 'utf8' });
}
const versions = sql('select version from supabase_migrations.schema_migrations order by version');
const expected = readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).map(name => name.split('_')[0]).sort().join('\n');
assert.equal(versions, expected);
mkdirSync('.pilot-evidence', { recursive: true });
writeFileSync('.pilot-evidence/migrations.json', JSON.stringify({ utc: new Date().toISOString(), target: container, port: 55322, versions: versions.split('\n'), cleanReplay: true, predecessorVersion: '0; source-only predecessor has no application migrations', upgradePreservedSentinel: true, outputs }, null, 2));
process.stdout.write(`Clean migration replay and empty-predecessor upgrade passed. Applied ${versions.split('\n').join(', ')}.\n`);
