import assert from "node:assert/strict";
import test from "node:test";

import { A_CASES, migrationPauseTriggerSql, parseUniquePgSleepBackend } from "../cases/a.mjs";

test("A-02 interrupts a real DDL boundary without any V1 workspace dependency", () => {
  const implementation = A_CASES.find(({ id }) => id === "A-02");
  assert.ok(implementation);
  const source = implementation.run.toString();
  assert.doesNotMatch(source, /v1Workspace|requireV1/u);
  assert.match(implementation.action, /first real DDL/u);
  assert.match(implementation.oracle, /partial public projection/u);
});

test("A-02 evaluator trigger is bounded to safe identifiers and a PostgreSQL DDL event", () => {
  const sql = migrationPauseTriggerSql({ functionName: "eg_a02_pause_1", triggerName: "eg_a02_trigger_1" });
  assert.match(sql, /returns event_trigger/u);
  assert.match(sql, /on ddl_command_end/u);
  assert.match(sql, /pg_sleep\(60\)/u);
  assert.throws(() => migrationPauseTriggerSql({ functionName: "pause;drop table x", triggerName: "trigger" }), /unsafe evaluator function name/u);
  assert.throws(() => migrationPauseTriggerSql({ functionName: "pause", triggerName: "trigger-with-dash" }), /unsafe evaluator trigger name/u);
});

test("A-02 accepts exactly one observed sleeping migration backend", () => {
  assert.equal(parseUniquePgSleepBackend(" 12345\n"), 12345);
  assert.throws(() => parseUniquePgSleepBackend(""), /exactly one migration backend/u);
  assert.throws(() => parseUniquePgSleepBackend("123\n456\n"), /exactly one migration backend/u);
  assert.throws(() => parseUniquePgSleepBackend("not-a-pid\n"), /positive PostgreSQL PID/u);
});
