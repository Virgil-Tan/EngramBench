import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const [task, variable, pid] of [['escrowguard', 'terminate', 'migrationPid'], ['permitforge', 'terminateSql', 'observedPid']]) {
  test(`${task} migration fault injection targets only the observed PostgreSQL backend`, () => {
    const source = readFileSync(new URL(`../evaluators/transfer/${task}/v2/cases/a.mjs`, import.meta.url), 'utf8');
    const line = source.split('\n').find(line => line.includes(`const ${variable} = \``));
    assert(line, 'exercise the SQL actually passed to psql by the migration case');
    const sql = new Function(pid, `${line};return ${variable}`)(12345).toLowerCase();
    assert.equal(sql, "select case when exists(select 1 from pg_stat_activity where datname=current_database() and pid=12345 and wait_event='pgsleep') then case when pg_terminate_backend(12345) then 1 else 0 end else 0 end");
    assert(!sql.includes('pg_terminate_backend(pid)'), 'a WHERE predicate must not execute a side effect on arbitrary rows');
  });
}
