#!/usr/bin/env node
import { cp, lstat, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadTaskPackageV1 } from '../src/task-package-v1.mjs';
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--task' || args[2] !== '--output' || !/^[a-z][a-z0-9]+$/.test(args[1])) throw new Error('Usage: npm run prepare:task -- --task TASK_ID --output NEW_DIRECTORY');
const root = resolve(import.meta.dirname, '..'), destination = resolve(args[3]);
const task = await loadTaskPackageV1(join(root, 'task-packages/v2', args[1]));
if (await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw new Error('Output already exists; never overwrite a run workspace');
await mkdir(destination, { recursive: true });
await cp(task.paths.workspace, destination, { recursive: true });
await cp(task.paths.plan, join(destination, 'FROZEN_PLAN.md'));
console.log(JSON.stringify({ task: args[1], workspace: destination, packageDigest: task.digests.package, containsPrivateTests: false }));
