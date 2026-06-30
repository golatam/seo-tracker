#!/usr/bin/env node
/**
 * Bulk-import keyword CSV into a Topvisor project using the central seo-tracker .env.
 *
 * Usage:
 *   node scripts/import-topvisor-keywords.mjs <project-id-or-descriptor-id> <csv-path> [--dry-run]
 *
 * CSV must include a header row. Recommended fields:
 *   name;target;group_name
 *
 * This script intentionally does NOT run positions checker/go.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from './env.mjs';
import { getKeywords, getProjects, topvisorRequest } from './providers/topvisor.mjs';

function usage(exitCode = 1) {
  console.error('Usage: node scripts/import-topvisor-keywords.mjs <project-id-or-descriptor-id> <csv-path> [--dry-run]');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => arg !== '--dry-run');
  if (positional.length !== 2) usage();
  return { projectRef: positional[0], csvPath: positional[1], dryRun };
}

function resolveProjectId(projectRef) {
  if (/^\d+$/.test(projectRef)) return Number(projectRef);

  const descriptorPath = resolve(process.cwd(), 'projects', `${projectRef}.json`);
  if (!existsSync(descriptorPath)) {
    throw new Error(`Project descriptor not found: ${descriptorPath}`);
  }

  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (!descriptor.topvisorProjectId) {
    throw new Error(`projects/${projectRef}.json has no topvisorProjectId`);
  }
  return Number(descriptor.topvisorProjectId);
}

function readCsv(csvPath) {
  const resolved = resolve(process.cwd(), csvPath);
  if (!existsSync(resolved)) throw new Error(`CSV not found: ${resolved}`);
  const content = readFileSync(resolved, 'utf8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must contain a header and at least one keyword row');
  if (!/^name[;,\t]/i.test(lines[0])) {
    throw new Error('CSV header must start with `name` (recommended: name;target;group_name)');
  }
  return { content, resolved, rowCount: lines.length - 1 };
}

function keywordRows(result) {
  return Array.isArray(result) ? result : (result.keywords || result.records || result.result || []);
}

async function main() {
  loadEnv();
  const { projectRef, csvPath, dryRun } = parseArgs(process.argv);
  const projectId = resolveProjectId(projectRef);
  const csv = readCsv(csvPath);

  const projects = await getProjects();
  const projectList = Array.isArray(projects) ? projects : (projects.projects || projects.records || []);
  const project = projectList.find((item) => Number(item.id) === projectId);
  if (!project) throw new Error(`Topvisor project ${projectId} is not visible to the configured account`);

  const before = keywordRows(await getKeywords(projectId, { limit: 1000 }));

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'import',
    project: { id: project.id, url: project.url, name: project.name },
    csv: { path: csv.resolved, rows: csv.rowCount },
    beforeKeywords: before.length,
  }));

  if (dryRun) return;

  const result = await topvisorRequest('add', 'keywords_2', 'keywords/import', {
    project_id: projectId,
    keywords: csv.content,
    move_duplicate: 0,
  });

  const after = keywordRows(await getKeywords(projectId, { limit: 1000 }));

  console.log(JSON.stringify({
    result: {
      countSended: result.countSended,
      countDuplicated: result.countDuplicated,
      countAdded: result.countAdded,
      countChanged: result.countChanged,
    },
    afterKeywords: after.length,
  }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
