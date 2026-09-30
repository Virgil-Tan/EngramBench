#!/usr/bin/env node
// Environment selection only. V2 never rewrites submitted source or wire formats.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mapping = JSON.parse(readFileSync(new URL('../environments/evaluator-execution.v1.json', import.meta.url)));
const host = mapping.hosts[process.arch];
if (!host) throw new Error(`No native evaluator profile for ${process.arch}`);
const images = new Set(Object.values(mapping.hosts).map(profile => profile.image));
const image = process.env.ENGRAMBENCH_EVALUATOR_IMAGE ?? host.image;
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Evaluator image must be a pinned local sha256 image ID');
const args = process.argv.slice(2).map(value => value === 'linux/arm64' || value === 'linux/amd64' ? host.platform : images.has(value) ? image : value);
const child = spawn(process.env.FRONTAL_DOCKER_COMMAND ?? 'docker', args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
